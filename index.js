const os = require("os"),
    fs = require("fs"),
    path = require("path"),
    https = require("https"),
    spawnSync = require("child_process").spawnSync,
    core = require("../JsGithubActionEmulator/core")

class Action {
    constructor() {
        this.projectFile = core.getInput("INPUT_PROJECT_FILE_PATH")
        this.configuration = core.getInput("INPUT_BUILD_CONFIGURATION") || "Release"
        this.platform = core.getInput("INPUT_BUILD_PLATFORM")
        this.packageName = core.getInput("INPUT_PACKAGE_NAME") || core.getInput("PACKAGE_NAME")
        this.versionFile = core.getInput("INPUT_VERSION_FILE_PATH") || core.getInput("VERSION_FILE_PATH") || this.projectFile
        this.versionRegex = new RegExp(core.getInput("INPUT_VERSION_REGEX") || core.getInput("VERSION_REGEX"), "m")
        this.version = core.getInput("INPUT_VERSION_STATIC") || core.getInput("VERSION_STATIC")
        this.tagCommit = core.getInput("INPUT_TAG_COMMIT") || core.getInput("TAG_COMMIT")
        this.tagFormat = core.getInput("INPUT_TAG_FORMAT") || core.getInput("TAG_FORMAT")
        this.nugetKey = core.getInput("INPUT_NUGET_KEY") || core.getInput("NUGET_KEY")
        this.nugetSource = core.getInput("INPUT_NUGET_SOURCE") || core.getInput("NUGET_SOURCE")
        this.nuspecFile = core.getInput("INPUT_NUSPEC_FILE")
        this.includeSymbols = core.getInput("INPUT_INCLUDE_SYMBOLS") || core.getInput("INCLUDE_SYMBOLS")
    }

    _printErrorAndExit(msg) {
        console.log(`##[error]😭 ${msg}`)
        throw new Error(msg)
    }

    _executeCommand(cmd, options) {
        console.log(`executing: [${cmd}]`)

        const INPUT = cmd.split(" "), TOOL = INPUT[0], ARGS = INPUT.slice(1)
        return spawnSync(TOOL, ARGS, options)
    }

    _executeInProcess(cmd, currentDir = '.') {
        this._executeCommand(cmd, { encoding: "utf-8", stdio: [process.stdin, process.stdout, process.stderr], cwd:currentDir })
    }

    _tagCommit(version) {
        const TAG = this.tagFormat.replace("*", version)

        console.log(`✨ creating new tag ${TAG}`)

        this._executeInProcess(`git tag ${TAG}`)
        this._executeInProcess(`git push origin ${TAG}`)

        process.stdout.write(`::set-output name=VERSION::${TAG}` + os.EOL)
    }

    
    _getFiles(dir) {
        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        const files = (dirents.map((dirent) => {
            const res = path.resolve(dir, dirent.name);
            return dirent.isDirectory() ? this._getFiles(res) : res;
        }));
        return Array.prototype.concat(...files);
    }

    _pushPackage(version, name) {
        console.log(`✨ found new version (${version}) of ${name}`)

        if (!this.nugetKey) {
            console.log("##[warning]😢 NUGET_KEY not given")
            return
        }

        console.log(`NuGet Source: ${this.nugetSource}`)

        const dir = path.dirname(this.projectFile);
        let files = this._getFiles(dir);
        files.filter(fn => /\.s?nupkg$/.test(fn)).forEach(fn => {
            console.log(`unlinking ${fn}`);
            fs.unlinkSync(fn);
    })

        this._executeInProcess(`dotnet build ${this.configuration ? "--configuration "+this.configuration : ""} ${this.projectFile} ${this.platform ? "-property:Platform="+this.platform : ""}`)

const cmd = `dotnet pack ${this.includeSymbols ? "--include-symbols -property:SymbolPackageFormat=snupkg" : ""} -property:NuspecFile=${this.nuspecFile} --no-build  ${this.configuration ? "--configuration "+this.configuration : ""} ${this.projectFile} ${this.platform ? "-property:Platform="+this.platform : ""} `;
console.log('[PACK] :: '+cmd)
        this._executeInProcess(cmd,path.dirname(this.projectFile))

        // const packages = fs.readdirSync(".").filter(fn => {console.log(`is ${fn} a nuget ?`); return fn.endsWith("nupkg")});

        
        files = this._getFiles(dir);
        console.log(files);
        const packages = this._getFiles(dir).filter(fn => {console.log(`(getFiles) : is ${fn} a nuget  ? ${fn.endsWith("nupkg")}`); return fn.endsWith("nupkg")});

        console.log(`Generated Package(s): ${packages.join(", ")}`)

        const pushCmd = `dotnet nuget push *.nupkg --source ${this.nugetSource}/v3/index.json --api-key ${this.nugetKey} --skip-duplicate ${!this.includeSymbols ? "--no-symbols" : ""}`;
        console.log("[PUSH] :: "+pushCmd);
        const pushOutput = this._executeCommand(pushCmd, { encoding: "utf-8" }).stdout

        console.log(pushOutput)

        if (/error/.test(pushOutput))
            this._printErrorAndExit(`${/error.*/.exec(pushOutput)[0]}`)

        const packageFilename = packages.filter(p => p.endsWith(".nupkg"))[0],
            symbolsFilename = packages.filter(p => p.endsWith(".snupkg"))[0]

        process.stdout.write(`::set-output name=PACKAGE_NAME::${packageFilename}` + os.EOL)
        process.stdout.write(`::set-output name=PACKAGE_PATH::${path.resolve(packageFilename)}` + os.EOL)

        if (symbolsFilename) {
            process.stdout.write(`::set-output name=SYMBOLS_PACKAGE_NAME::${symbolsFilename}` + os.EOL)
            process.stdout.write(`::set-output name=SYMBOLS_PACKAGE_PATH::${path.resolve(symbolsFilename)}` + os.EOL)
        }

        if (this.tagCommit)
            this._tagCommit(version)
    }

    _checkForUpdate() {
        if (!this.packageName) {
            this.packageName = path.basename(this.projectFile).split(".").slice(0, -1).join(".")
        }

        console.log(`Package Name: ${this.packageName}`)

        https.get(`${this.nugetSource}/v3-flatcontainer/${this.packageName}/index.json`, res => {
            let body = ""

            if (res.statusCode == 404)
                this._pushPackage(this.version, this.packageName)

            if (res.statusCode == 200) {
                res.setEncoding("utf8")
                res.on("data", chunk => body += chunk)
                res.on("end", () => {
                    const existingVersions = JSON.parse(body)
                    if (existingVersions.versions.indexOf(this.version) < 0)
                        this._pushPackage(this.version, this.packageName)
                })
            }
        }).on("error", e => {
            this._printErrorAndExit(`error: ${e.message}`)
        })
    }

    run() {
        if (!this.projectFile || !fs.existsSync(this.projectFile))
            this._printErrorAndExit("project file not found")

        console.log(`Project Filepath: ${this.projectFile}`)

        if (!this.version) {
            if (this.versionFile !== this.projectFile && !fs.existsSync(this.versionFile))
                this._printErrorAndExit("version file not found")

            console.log(`Version Filepath: ${this.versionFile}`)
            console.log(`Version Regex: ${this.versionRegex}`)

            const versionFileContent = fs.readFileSync(this.versionFile, { encoding: "utf-8" }),
                parsedVersion = this.versionRegex.exec(versionFileContent)

            if (!parsedVersion)
                this._printErrorAndExit("unable to extract version info!")

            this.version = parsedVersion[1]
        }

        console.log(`Version: ${this.version}`)

        this._checkForUpdate()
    }
}

new Action().run()
