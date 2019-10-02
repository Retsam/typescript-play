// whoa, no typescript and no compilation!

const globalishObj = typeof globalThis !== 'undefined' ? globalThis : window || {}
globalishObj.typeDefs = {}

const languageType = ({ isJS }) => isJS ? "javascript" : "typescript"
const monacoLanguageDefaults = ({isJS}) => isJS ? monaco.languages.typescript.javascriptDefaults : monaco.languages.typescript.typescriptDefaults
const monacoLanguageWorker = ({isJS}) =>  isJS ? monaco.languages.typescript.getJavaScriptWorker : monaco.languages.typescript.getTypeScriptWorker

// Don't ever ship this un-commented
/**  * @type import("monaco-editor")  */
// let monaco


const LibManager = {
  libs: {},

  coreLibPath: `https://unpkg.com/typescript@${window.CONFIG.TSVersion}/lib/`,

  getReferencePaths(input) {
    const rx = /<reference path="([^"]+)"\s\/>/;
    return (input.match(new RegExp(rx.source, "g")) || []).map(s => {
      const match = s.match(rx);
      if (match && match.length >= 2) {
        return match[1];
      } else {
        throw new Error(`Error parsing: "${s}".`);
      }
    })
  },

  basename(url) {
    const parts = url.split("/");
    if (parts.length === 0) {
      throw new Error(`Bad url: "${url}"`);
    }
    return parts[parts.length - 1];
  },

  addLib: async function(path, ...args) {
    if (path.indexOf("http") === 0) {
      return this._addRemoteLib(path, ...args);
    }
    return this._addCoreLib(path, ...args);
  },

  _addCoreLib: async function(fileName, ...args) {
    return this._addRemoteLib(`${this.coreLibPath}${fileName}`, ...args);
  },

  _addRemoteLib: async function(url, stripNoDefaultLib = true, followReferences = true) {
    const fileName = this.basename(url);

    if (this.libs[fileName]) {
      return;
    }

    UI.toggleSpinner(true);
    const res = await fetch(url)
    if (res.status === 404) {
      console.log(`Check https://unpkg.com/typescript@${window.CONFIG.TSVersion}/lib/`);
    }
    const rawText = await res.text();

    UI.toggleSpinner(false);

    const text = stripNoDefaultLib ? rawText.replace('/// <reference no-default-lib="true"/>', "") : rawText;

    if (followReferences) {
      const paths = this.getReferencePaths(text);
      if (paths.length > 0) {
        console.log(`${fileName} depends on ${paths.join(", ")}`);
        for (const path of paths) {
          await this._addCoreLib(path, stripNoDefaultLib, followReferences);
        }
      }
    }

    const lib = monacoLanguageDefaults({ isJS: fileName.endsWith("ts") }).addExtraLib(text, fileName);

    console.groupCollapsed(`Added '${fileName}'`);
    console.log(text);
    console.groupEnd();

    this.libs[fileName] = lib;

    return lib;
  },

  acquireModuleMetadata: {},

  /**
   * @param {string} sourceCode
   */
  detectNewImportsToAcquireTypeFor: async function(sourceCode) {

   /**
   * @param {string} sourceCode
   * @param {string | undefined} mod
   * @param {string | undefined} path
   */
    const getTypeDependenciesForSourceCode = async (sourceCode, mod, path) => {
      // TODO: debounce
      //
      // TODO: This needs to be replaced by the AST - it still works in comments
      // blocked by https://github.com/microsoft/monaco-typescript/pull/38
      //
      // https://regex101.com/r/Jxa3KX/4
      const requirePattern = /(const|let|var)(.|\n)*? require\(('|")(.*)('|")\);?$/
      //  https://regex101.com/r/hdEpzO/4
      const es6Pattern = /(import|export)((?!from)(?!require)(.|\n))*?(from|require\()\s?('|")(.*)('|")\)?;?$/gm

      const foundModules = new Set()

      while ((match = es6Pattern.exec(sourceCode)) !== null) {
        if (match[6]) foundModules.add(match[6])
      }

      while ((match = requirePattern.exec(sourceCode)) !== null) {
        if (match[5]) foundModules.add(match[5])
      }

      const moduleJSONURL = (name) => `https://ofcncog2cu-dsn.algolia.net/1/indexes/npm-search/${name}?attributes=types&x-algolia-agent=Algolia%20for%20vanilla%20JavaScript%20(lite)%203.27.1&x-algolia-application-id=OFCNCOG2CU&x-algolia-api-key=f54e21fa3a2a0160595bb058179bfb1e`
      const unpkgURL = (name, path) => `https://www.unpkg.com/${encodeURIComponent(name)}/${encodeURIComponent(path)}`
      const packageJSONURL = (name) => unpkgURL(name, "package.json")
      const errorMsg = (msg, response) => { console.error(`${msg} - will not try again in this session`, response.status, response.statusText, response); debugger }

      const addLibraryToRuntime = (code, path) => {
        const defaults = monacoLanguageDefaults({ isJS: path.endsWith("js") })
        defaults.addExtraLib(code, path);

        globalishObj.typeDefs[path] = code
        console.log(`Adding ${path} to runtime`)
      }

      const getReferenceDependencies = async (sourceCode, mod, path) => {
        if (sourceCode.indexOf("reference path") > 0) {
          // https://regex101.com/r/DaOegw/1
          const referencePathExtractionPattern = /<reference path="(.*)" \/>/gm;
          while ((match = referencePathExtractionPattern.exec(sourceCode)) !== null) {
            const relativePath = match[1];
            if (relativePath) {
              let newPath = mapRelativePath(mod, relativePath, path);
              if (newPath) {
                const dtsRefURL = unpkgURL(mod, newPath);
                const dtsReferenceResponse = await fetch(dtsRefURL);
                if (!dtsReferenceResponse.ok) {
                  return errorMsg(
                    `Could not get ${newPath} for a reference link in the module '${mod}' from ${path}`,
                    dtsReferenceResponse
                  );
                }

                let dtsReferenceResponseText = await dtsReferenceResponse.text();
                if (!dtsReferenceResponseText) {
                  return errorMsg(
                    `Could not get ${newPath} for a reference link for the module '${mod}' from ${path}`,
                    dtsReferenceResponse
                  );
                }

                await getTypeDependenciesForSourceCode(dtsReferenceResponseText, mod, newPath);
                const representationalPath = `node_modules/${mod}/${newPath}`;
                addLibraryToRuntime(dtsReferenceResponseText, representationalPath);
              }
            }
          }
        }
      };


      /**
       * Takes an initial module and the path for the root of the typings and grab it and start grabbing its
       * dependencies then add those the to runtime.
       *
       * @param {string} mod The module name
       * @param {string} path  The path to the root def type
       */
      const addModuleToRuntime =  async (mod, path) => {
        const isDeno = path && path.indexOf("https://") === 0

        const dtsFileURL = isDeno ? path : unpkgURL(mod, path)
        const dtsResponse = await fetch(dtsFileURL)
        if (!dtsResponse.ok) { return errorMsg(`Could not get root d.ts file for the module '${mod}' at ${path}`, dtsResponse) }

        // TODO: handle checking for a resolve to index.d.ts whens someone imports the folder
        let content = await dtsResponse.text()
        if (!content) { return errorMsg(`Could not get root d.ts file for the module '${mod}' at ${path}`, dtsResponse) }

        // Now look and grab dependent modules where you need the
        //
        await getTypeDependenciesForSourceCode(content, mod, path)

        if (isDeno) {
          const wrapped = `declare module "${path}" { ${content} }`
          addLibraryToRuntime(wrapped, path)
        } else {
          const typelessModule = mod.split("@types/").slice(-1)
          const wrapped = `declare module "${typelessModule}" { ${content} }`
          addLibraryToRuntime(wrapped, `node_modules/${mod}/${path}`)
        }
      }



        /**
         * Takes a module import, then uses both the algolia API and the the package.json to derive
         * the root type def path.
         *
         * @param {string} packageName
         * @returns {Promise<{ mod: string, path: string, packageJSON: any }>}
         */
      const getModuleAndRootDefTypePath = async (packageName) => {

        // For modules
        const url = moduleJSONURL(packageName)

        const response = await fetch(url)
        if (!response.ok) { return errorMsg(`Could not get Algolia JSON for the module '${packageName}'`,  response) }

        const responseJSON = await response.json()
        if (!responseJSON) { return errorMsg(`Could not get Algolia JSON for the module '${packageName}'`, response) }

        if (!responseJSON.types) { return console.log(`There were no types for '${packageName}' - will not try again in this session`)  }
        if (!responseJSON.types.ts) { return console.log(`There were no types for '${packageName}' - will not try again in this session`)  }

        this.acquireModuleMetadata[packageName] = responseJSON

        if (responseJSON.types.ts === "included") {
          const modPackageURL = packageJSONURL(packageName)

          const response = await fetch(modPackageURL)
          if (!response.ok) { return errorMsg(`Could not get Package JSON for the module '${packageName}'`, response) }

          const responseJSON = await response.json()
          if (!responseJSON) { return errorMsg(`Could not get Package JSON for the module '${packageName}'`, response) }

          // Get the path of the root d.ts file

          // non-inferred route
          let rootTypePath = responseJSON.typing || responseJSON.typings || responseJSON.types

          // package main is custom
          if (!rootTypePath && typeof responseJSON.main === 'string' && responseJSON.main.indexOf('.js') > 0) {
            rootTypePath = responseJSON.main.replace(/js$/, 'd.ts');
          }

          // Final fallback, to have got here it must have passed in algolia
          if (!rootTypePath) {
            rootTypePath = "index.d.ts"
          }

          return { mod: packageName, path: rootTypePath, packageJSON: responseJSON }
        } else if(responseJSON.types.ts === "definitely-typed") {
          return { mod: responseJSON.types.definitelyTyped, path: "index.d.ts", packageJSON: responseJSON }
        } else {
          throw "This shouldn't happen"
        }
      }

      const mapModuleNameToModule = (name) => {
        // in node repl:
        // > require("module").builtinModules
        const builtInNodeMods = ["assert", "async_hooks", "base", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "globals", "http", "http2", "https", "index", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib"]
        if (builtInNodeMods.includes(name)) {
          return "node"
        }
        return name
      }

      //** A really dumb version of path.resolve */
      const mapRelativePath = (outerModule, moduleDeclaration, currentPath) => {
        // https://stackoverflow.com/questions/14780350/convert-relative-path-to-absolute-using-javascript
        function absolute(base, relative) {
          if(!base) return relative

          const stack = base.split("/")
          const parts = relative.split("/");
          stack.pop(); // remove current file name (or empty string)

          for (var i = 0; i < parts.length; i++) {
              if (parts[i] == ".") continue;
              if (parts[i] == "..") stack.pop();
              else stack.push(parts[i]);
          }
          return stack.join("/");
        }

        return absolute(currentPath, moduleDeclaration)
      }

      const convertToModuleReferenceID = (outerModule, moduleDeclaration, currentPath) => {
        const modIsScopedPackageOnly = moduleDeclaration.indexOf("@") === 0 && moduleDeclaration.split("/").length === 2
        const modIsPackageOnly = moduleDeclaration.indexOf("@") === -1 && moduleDeclaration.split("/").length === 1
        const isPackageRootImport = modIsPackageOnly || modIsScopedPackageOnly

        if (isPackageRootImport) {
          return moduleDeclaration
        } else {
          return  `${outerModule}-${mapRelativePath(outerModule, moduleDeclaration, currentPath)}`
        }
      }


      /** @type {string[]} */
      const filteredModulesToLookAt =  Array.from(foundModules)

      filteredModulesToLookAt.forEach(async name => {
        // Support grabbing the hard-coded node modules if needed
        const moduleToDownload = mapModuleNameToModule(name)

        if (!mod && moduleToDownload.startsWith(".") ) {
          return console.log("Can't resolve local relative dependencies")
        }

        const moduleID = convertToModuleReferenceID(mod, moduleToDownload, path)
        if (this.acquireModuleMetadata[moduleID] || this.acquireModuleMetadata[moduleID] === null) {
          return
        }

        const modIsScopedPackageOnly = moduleToDownload.indexOf("@") === 0 && moduleToDownload.split("/").length === 2
        const modIsPackageOnly = moduleToDownload.indexOf("@") === -1 && moduleToDownload.split("/").length === 1
        const isPackageRootImport = modIsPackageOnly || modIsScopedPackageOnly
        const isDenoModule = moduleToDownload.indexOf("https://") === 0

        if (isPackageRootImport) {
          // So it doesn't run twice for a package
          this.acquireModuleMetadata[moduleID] = null

          // E.g. import danger from "danger"
          const packageDef = await getModuleAndRootDefTypePath(moduleToDownload)

          if (packageDef) {
            this.acquireModuleMetadata[moduleID] = packageDef.packageJSON
            await addModuleToRuntime(packageDef.mod, packageDef.path)
          }
        } else if (isDenoModule) {
          // E.g. import { serve } from "https://deno.land/std@v0.12/http/server.ts";
          await addModuleToRuntime(moduleToDownload, moduleToDownload)
        } else {
          // E.g. import {Component} from "./MyThing"
          if (!moduleToDownload || !path) throw `No outer module or path for a relative import: ${moduleToDownload}`

          const absolutePathForModule = mapRelativePath(mod, moduleToDownload, path)
          // So it doesn't run twice for a package
          this.acquireModuleMetadata[moduleID] = null
          const resolvedFilepath = absolutePathForModule.endsWith(".ts") ? absolutePathForModule : absolutePathForModule + ".d.ts"
          await addModuleToRuntime(mod, resolvedFilepath)
        }
      })
      getReferenceDependencies(sourceCode, mod, path)
    }

    // Start diving into the root
    getTypeDependenciesForSourceCode(sourceCode, undefined, undefined)
  }
};

async function main() {
  const trueInJS = window.CONFIG.useJavaScript
  const trueInTS = !window.CONFIG.useJavaScript

  const defaultCompilerOptions = {
    noImplicitAny: true,
    strictNullChecks: trueInTS,
    strictFunctionTypes: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,

    alwaysStrict: true,
    allowUnreachableCode: false,
    allowUnusedLabels: false,

    downlevelIteration: false,
    noEmitHelpers: false,
    noLib: false,
    noStrictGenericChecks: false,
    noUnusedLocals: false,
    noUnusedParameters: false,

    esModuleInterop: false,
    preserveConstEnums: false,
    removeComments: false,
    skipLibCheck: false,

    checkJs: trueInJS,
    allowJs: trueInJS,

    experimentalDecorators: false,
    emitDecoratorMetadata: false,

    target: monaco.languages.typescript.ScriptTarget.ES2017,
    jsx: monaco.languages.typescript.JsxEmit.None,
  };

  const urlDefaults = Object.entries(defaultCompilerOptions).reduce(
    (acc, [key, value]) => {
      if (params.has(key)) {
        const urlValue = params.get(key);

        if (urlValue === "true") {
          acc[key] = true;
        } else if (urlValue === "false") {
          acc[key] = false;
        } else if (!isNaN(parseInt(urlValue, 10))) {
          acc[key] = parseInt(params.get(key), 10);
        }
      }

      return acc;
    },
    {},
  );

  console.log("Url defaults", urlDefaults);

  const compilerOptions = Object.assign(
    {},
    defaultCompilerOptions,
    urlDefaults,
  );

  const sharedEditorOptions = {
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: true,
    scrollBeyondLastColumn: 3
  };

  const State = {
    inputModel: null,
    outputModel: null,
  };

  /** @type import("monaco-editor").editor.IStandaloneCodeEditor */
  let inputEditor;
  /** @type import("monaco-editor").editor.IStandaloneCodeEditor */
  let outputEditor;

  function createSelect(obj, globalPath, title, compilerOption) {
    return `<label class="select">
    <span class="select-label">${title}</span>
  <select onchange="console.log(event.target.value); UI.updateCompileOptions('${compilerOption}', ${globalPath}[event.target.value]); event.stopPropagation();">
  ${Object.keys(obj)
    .filter(key => isNaN(Number(key)))
    .map(key => {
      if (key === "Latest") {
        // hide Latest
        return "";
      }

      const isSelected = obj[key] === compilerOptions[compilerOption];

      return `<option ${isSelected ? "selected" : ""} value="${key}">${key}</option>`;
    })}
  </select>
  </label>`;
  }

  function createFile(compilerOptions) {
    const isJSX = compilerOptions.jsx !== monaco.languages.typescript.JsxEmit.None
    const fileExt = window.CONFIG.useJavaScript ? "js" : "ts"
    const ext = isJSX ? fileExt + "x" : fileExt
    const filepath = "input." + ext
    console.log("File: ", filepath)
    return monaco.Uri.file(filepath)
  }

  window.UI = {
    tooltips: {},

    shouldUpdateHash: false,

    showFlashMessage(message) {
      const node = document.querySelector(".flash");
      const messageNode = node.querySelector(".flash__message");

      messageNode.textContent = message;

      node.classList.toggle("flash--hidden", false);
      setTimeout(() => {
        node.classList.toggle("flash--hidden", true);
      }, 1000);
    },

    openDropdownsOnLaunchIfNeeded() {
      console.log("launch", location.hash)
      if (location.hash.startsWith("#show-examples")) {
        document.getElementById("examples").parentElement.children[0].click()
      }
  
      if (location.hash.startsWith("#show-whatisnew")) {
        // Get to whatisnew, then the sibling a which needs clicking on
        document.getElementById("whatisnew").parentElement.children[0].click()
      }
    },

    fetchTooltips: async function() {
      try {
        this.toggleSpinner(true);
        const res = await fetch(`${window.CONFIG.siteRoot}/play/schema/tsconfig.json`);
        if(!res.ok) return

        const json = await res.json();
        this.toggleSpinner(false);

        for (const [propertyName, property] of Object.entries(
          json.definitions.compilerOptionsDefinition.properties.compilerOptions
            .properties,
        )) {
          this.tooltips[propertyName] = property.description;
        }
      } catch (e) {
        console.error(e);
        // not critical
      }
    },

    renderAvailableVersions() {
      const node = document.querySelector("#versions");
      const html = `

    ${Object.keys(window.CONFIG.availableTSVersions)
      .filter(v => v !== "Nightly")
      .sort()
      .reverse()
      .map(version => {
        return `<li class="button" onclick="javascript:UI.selectVersion('${version}');"><a href="#">${version}</a></li>`;
      })
      .join("\n")}

      <li role="separator" class="divider"></li>
      <li class="button" onclick="javascript:UI.selectVersion('Nightly');"><a href="#">Nightly</a></li>
    `;

      node.innerHTML = html;
    },

    renderVersion() {
      const childNode = document.querySelector("#active-version");
      childNode.innerHTML = `v${window.CONFIG.TSVersion} <span class="caret"></span>`;

      this.toggleSpinner(false);
    },

    toggleSpinner(shouldShow) {
      // document
      //   .querySelector(".spinner")
      //   .classList.toggle("spinner--hidden", !shouldShow);
    },

    updateIsJavaScript(shouldUseJS) {
      window.CONFIG.useJavaScript = shouldUseJS
      UI.updateEditorStateAfterChange()
      document.location.reload()
    },

    renderSettings() {
      const focused = document.activeElement
      let nameToFocus = null
      if (focused && focused.name) {
        nameToFocus = focused.name
      }

      const node = document.querySelector("#config");
      const isJS = window.CONFIG.useJavaScript
      const html = `
      ${createSelect(
        monaco.languages.typescript.ScriptTarget,
        "monaco.languages.typescript.ScriptTarget",
        "Target",
        "target",
      )}
      <br />
      ${createSelect(
        monaco.languages.typescript.JsxEmit,
        "monaco.languages.typescript.JsxEmit",
        "JSX",
        "jsx",
      )}
      <br />
      <label class="select">
        <span class="select-label">Lang</span>
        <select onchange="UI.updateIsJavaScript(event.target.value === 'JavaScript'); event.stopPropagation();")>;
          <option>TypeScript</option>
          <option ${window.CONFIG.useJavaScript ? "selected" : ""}>JavaScript</option>
        </select>
      </label>

    <hr/>
    <p>Compiler options from the TS Config</p>
    <ul style="margin-top: 1em;">
    ${Object.entries(compilerOptions)
      .filter(([_, value]) => typeof value === "boolean")
      .map(([key, value]) => {
        return `<li style="margin: 0; padding: 0; ${isJS ? "opacity: 0.5" : ""}" title="${UI.tooltips[key] ||
          ""}"><label class="button" style="user-select: none; display: block;"><input class="pointer" onchange="javascript:UI.updateCompileOptions(event.target.name, event.target.checked);event.stopPropagation();" name="${key}" type="checkbox" ${
          value ? "checked" : ""
        }></input>${key}</label></li>`;
      })
      .join("\n")}
    </ul>
    <p style="margin-left: 0.5em; margin-top: 1em;">
      <a href="https://www.typescriptlang.org/docs/handbook/compiler-options.html" target="_blank">
        Compiler options reference
      </a>
    </p>
    `;

      node.innerHTML = html;

      if(nameToFocus) {
        window.config.querySelector(`input[name=${nameToFocus}]`).focus()
      }
    },

    console() {
      if (!window.ts) {
        return;
      }

      console.log(`Using TypeScript ${window.ts.version}`);

      console.log("Available globals:");
      console.log("\twindow.ts", window.ts);
      console.log("\twindow.client", window.client);
    },

    selectVersion(version) {
      if (version === window.CONFIG.getLatestVersion()) {
        location.href = `${window.CONFIG.baseUrl}${location.hash}`;
        return false;
      }

      location.href = `${window.CONFIG.baseUrl}?ts=${version}${location.hash}`;
      return false;
    },

    downloadExamplesTOC: async function() {
      const examplesTOCHref = `${window.CONFIG.siteRoot}/examplesTOC.json`
      const res = await fetch(examplesTOCHref);
      if (res.ok) {
        const toc = await res.json()
        const sections = toc.sections
        const examples = toc.examples
        const sortedSubSections = toc.sortedSubSections

        // We've got the JSON representing the TOC
        // so replace the "loading" html with
        // a real menu.
        const exampleMenu = document.getElementById("examples")
        const whatIsNewMenu = document.getElementById("whatisnew")

        // Set up two equivalent menu dropdowns

        exampleMenu.removeChild(exampleMenu.children[0])
        whatIsNewMenu.removeChild(whatIsNewMenu.children[0])

        const examplesSectionOL = document.createElement("ol")
        exampleMenu.appendChild(examplesSectionOL)

        const whatisNewSectionOL = document.createElement("ol")
        whatIsNewMenu.appendChild(whatisNewSectionOL)

        sections.forEach((s, i) => {
          const sectionUL = s.whatisnew ? whatisNewSectionOL : examplesSectionOL
          const sectionBody = s.whatisnew ? whatIsNewMenu : exampleMenu

          // Set up the TS/JS selection links at the top
          const sectionHeader = document.createElement("li")
          const sectionAnchor = document.createElement("button")
          sectionAnchor.textContent = s.name
          sectionAnchor.classList.add("section-name", "button")
          sectionHeader.appendChild(sectionAnchor)
          sectionUL.appendChild(sectionHeader)

          // A wrapper div, which is used to show/hide
          // the different sets of sections
          const sectionContent = document.createElement("div")
          sectionContent.id = s.name.toLowerCase()
          sectionContent.classList.add("section-content")
          sectionContent.style.display = i === 0 ? "flex" : "none"

          // Handle clicking on a section title, moved
          // further down so we can access the corresponding
          // content section element.
          sectionAnchor.onclick = (e) => {
            // Visible selection
            const allSectionTitles = sectionUL.querySelectorAll(".section-name")
            for (const title of allSectionTitles) { title.classList.remove("selected") }
            sectionAnchor.classList.add("selected")

            const allSections = sectionBody.querySelectorAll(".section-content")
            for (const section of allSections) {
              section.style.display = "none"
              section.classList.remove("selected")
            }
            sectionContent.style.display = "flex"
            sectionContent.classList.add("selected")

            if (e && e.stopPropagation) {
              e.stopPropagation()
            }
          }

          const sectionSubtitle = document.createElement("p")
          sectionSubtitle.innerHTML = s.subtitle
          sectionSubtitle.style.width = "100%"
          sectionContent.appendChild(sectionSubtitle)

          // Goes from a flat list of examples, to a
          // set of keys based on the section with
          // an array of corresponding examples
          const sectionDict = {}
          examples.forEach(e => {
            // Allow switching a "-" to "." so that titles can have
            // a dot for version numbers, this own works once.
            if (e.path[0] !== s.name.replace(".", "-")) return;

            if (sectionDict[e.path[1]]) {
              sectionDict[e.path[1]].push(e)
            } else {
              sectionDict[e.path[1]] = [e]
            }
          })

          // Grab the seen examples from your local storage
          let seenExamples = {}
          if (localStorage) {
            const examplesFromLS = localStorage.getItem("examples-seen") || "{}"
            seenExamples = JSON.parse(examplesFromLS)
          }

          // Looping through each section inside larger selection set, sorted by the index
          // of the sortedSubSections array in the toc json
          Object.keys(sectionDict)
            .sort( (lhs, rhs) => sortedSubSections.indexOf(lhs) - sortedSubSections.indexOf(rhs))
            .forEach(sectionName => {

            const section = document.createElement("div")
            section.classList.add("section-list")

            const sectionTitle = document.createElement("h4")
            sectionTitle.textContent = sectionName
            section.appendChild(sectionTitle)

            const sectionExamples = sectionDict[sectionName]
            const sectionExampleContainer = document.createElement("ol")

            sectionExamples.sort( (lhs, rhs) => lhs.sortIndex - rhs.sortIndex).forEach(e => {
              const example = document.createElement("li")

              const exampleName = document.createElement("a")
              exampleName.textContent = e.title
              const isJS = e.name.indexOf(".js") !== -1
              const prefix = isJS ? "useJavaScript=true" : ""

              const hash = "example/" + e.id
              // the e: rand(200) is so that each link has a unique querystring which will force a reload, unlike the hash
              const params = Object.assign(e.compilerSettings || {}, { e: Math.round(Math.random() * 200) })
              const query = prefix + objectToQueryParams(params)
              const newLocation = `${document.location.protocol}//${document.location.host}${document.location.pathname}?${query}#${hash}`
              exampleName.href = newLocation
              exampleName.title = "Open the example " +  e.title

              // To help people keep track of what they've seen,
              // we keep track of what examples they've seen and
              // what the SHA was at the time. This makes it feasible
              // for someone to work their way through the whole set
              const exampleSeen = document.createElement("div") // circle
              exampleSeen.classList.add("example-indicator")
              const seenHash = seenExamples[e.id]
              if (seenHash) {
                const isSame = seenHash === e.hash
                exampleSeen.classList.add(isSame ? "done" : "changed")
                exampleSeen.title = isSame ? "Seen example already" : "Seen example, but sample has changed since"
              }

              example.appendChild(exampleName)
              example.appendChild(exampleSeen)

              sectionExampleContainer.appendChild(example)
            })

            section.appendChild(sectionExampleContainer)
            sectionContent.appendChild(section)
            sectionBody.appendChild(sectionContent)
          })
        })

      }
      // set the first selection by default
      const sections = document.getElementsByClassName("section-name")
      if (!sections[0]) {
        console.warn("In dev mode you need to save a file in the examples to get the changes into the dev folder")
      } else {
        const exampleMenu = document.getElementById("examples")
        const whatIsNewMenu = document.getElementById("whatisnew")

        exampleMenu.querySelector(".section-name").onclick()
        whatIsNewMenu.querySelector(".section-name").onclick()
      }
    },

    selectExample: async function(exampleName) {
      try {
        const examplesTOCHref = "/examplesTOC.json"
        const res = await fetch(examplesTOCHref);
        if (!res.ok) {
          console.error("Could not fetch example TOC")
          return
        }

        const toc = await res.json()
        const example = toc.examples.find(e => e.id === exampleName)
        if (!example) {
          State.inputModel.setValue(`// Could not find example with id: ${exampleName} in\n// ${document.location.protocol}//${document.location.host}${examplesTOCHref}`);
          return
        }


        const codeRes = await fetch(`/ex/en/${example.path.join("/")}/${encodeURIComponent(example.name)}`,);
        let code = await codeRes.text();

        // Handle removing the compiler settings stuff
        if (code.startsWith("//// {")) {
          code = code.split("\n").slice(1).join("\n");
        }

        // Update the localstorage showing that you've seen this page
        if (localStorage) {
          const seenText = localStorage.getItem("examples-seen") || "{}"
          const seen = JSON.parse(seenText)
          seen[example.id] = example.hash
          localStorage.setItem("examples-seen", JSON.stringify(seen))
        }

        // Set the menu to be the same section as this current example
        // this happens behind the scene and isn't visible till you hover
        const sectionTitle = example.path[0]
        const allSectionTitles = document.getElementsByClassName("section-name")
        for (const title of allSectionTitles) {
          if (title.textContent === sectionTitle)  { title.onclick({}) }
        }

        document.title = "TypeScript Playground - " + example.title

        UI.shouldUpdateHash = false
        State.inputModel.setValue(code.trim());
        UI.shouldUpdateHash = true

      } catch (e) {
        console.log(e);
      }
    },

    setCodeFromHash: async function() {
      if (location.hash.startsWith("#example")) {
        const exampleName = location.hash.replace("#example/", "").trim();
        UI.selectExample(exampleName);
      }
    },

    refreshOutput() {
      UI.shouldUpdateHash = false;
      State.inputModel.setValue(State.inputModel.getValue());
      UI.shouldUpdateHash = true;
    },

    updateURL() {
      const diff = Object.entries(defaultCompilerOptions).reduce(
        (acc, [key, value]) => {
          if (value !== compilerOptions[key]) {
            acc[key] = compilerOptions[key];
          }

          return acc;
        },
        {},
      );

      const hash = `code/${LZString.compressToEncodedURIComponent(State.inputModel.getValue())}`;

      const urlParams = Object.assign({}, diff);

      ["lib", "ts"].forEach(param => {
        if (params.has(param)) {
          urlParams[param] = params.get(param);
        }
      });

      if (window.CONFIG.useJavaScript) urlParams["useJavaScript"] = true

      if (Object.keys(urlParams).length > 0) {
        const queryString = Object.entries(urlParams)
          .map(([key, value]) => {
            return `${key}=${encodeURIComponent(value)}`;
          })
          .join("&");

        window.history.replaceState({}, "", `${window.CONFIG.baseUrl}?${queryString}#${hash}`);
      } else {
        window.history.replaceState({}, "", `${window.CONFIG.baseUrl}#${hash}`);
      }
    },

    storeCurrentCodeInLocalStorage() {
      localStorage.setItem("playground-history", State.inputModel.getValue())
    },

    updateCompileOptions(name, value) {
      const isJS = window.CONFIG.useJavaScript
      console.log(`${name} = ${value}`);
      Object.assign(compilerOptions, { [name]: value });

      console.log("Updating compiler options to", compilerOptions);
      const defaults = monacoLanguageDefaults({ isJS })
      defaults.setCompilerOptions(compilerOptions)

      UI.updateEditorStateAfterChange()
    },

    updateEditorStateAfterChange() {
      let inputCode = inputEditor.getValue();
      State.inputModel.dispose();

      const language = languageType({ isJS:window.CONFIG.useJavaScript })
      State.inputModel = monaco.editor.createModel(inputCode, language, createFile(compilerOptions));
      inputEditor.setModel(State.inputModel);

      UI.refreshOutput();
      UI.renderSettings();
      UI.updateURL();
    },

    getInitialCode() {
      if (location.hash.startsWith("#src")) {
        const code = location.hash.replace("#src=", "").trim();
        return decodeURIComponent(code);
      }

      if (location.hash.startsWith("#code")) {
        const code = location.hash.replace("#code/", "").trim();
        return LZString.decompressFromEncodedURIComponent(code);
      }

      if (location.hash.startsWith("#example")) {
        return "// Loading example..."
      }

      if (localStorage.getItem("playground-history")) {
        return localStorage.getItem("playground-history")
      }

      return `
const message: string = 'hello world';
console.log(message);
  `.trim();
    },
  };

  window.MonacoEnvironment = {
    getWorkerUrl: function(workerId, label) {
      return `worker.js?version=${window.CONFIG.getMonacoVersion()}&editorModule=${window.CONFIG.getMonacoModule()}`;
    },
  };

  for (const path of window.CONFIG.extraLibs) {
    await LibManager.addLib(path);
  }

  const defaults = monacoLanguageDefaults({ isJS: window.CONFIG.useJavaScript })
  defaults.setCompilerOptions(compilerOptions)

  const language = languageType({ isJS:  window.CONFIG.useJavaScript })
  State.inputModel = monaco.editor.createModel(UI.getInitialCode(), language, createFile(compilerOptions));

  const outputDefault = window.CONFIG.useJavaScript ? "// Using JavaScript, no compilation needed." : ""
  State.outputModel = monaco.editor.createModel(outputDefault, "javascript", monaco.Uri.file("output.js"));

  monaco.editor.defineTheme("sandbox", sandboxTheme)
  monaco.editor.setTheme("sandbox")

  inputEditor = monaco.editor.create(
    document.getElementById("input"),
    Object.assign({
      model: State.inputModel,
    }, sharedEditorOptions),
    {
      openerService: {
        registerOpener: () => { },
        registerValidator: () => {},
        // Override the custom http url opener to open in the current tab
        open: (resource, _options) => {
          const url = decodeURIComponent(resource.toString())
          document.location = url
          document.location.reload()
        }
      }
    }
  );

  outputEditor = monaco.editor.create(
    document.getElementById("output"),
    Object.assign({
      model: State.outputModel,
      readOnly: window.CONFIG.useJavaScript
    }, sharedEditorOptions),
  );

  function updateOutput() {
    const isJS = window.CONFIG.useJavaScript
    const getWorkerProcess = monacoLanguageWorker({ isJS })

    getWorkerProcess().then(worker => {
      worker(State.inputModel.uri).then((client, a) => {
        if (typeof window.client === "undefined") {
          UI.renderVersion();

          // expose global
          window.client = client;
          UI.console();
        }

        const userInput = State.inputModel
        const sourceCode =  userInput.getValue()
        LibManager.detectNewImportsToAcquireTypeFor(sourceCode)

        if(!isJS) {
          client.getEmitOutput(userInput.uri.toString()).then(result => {
            State.outputModel.setValue(result.outputFiles[0].text);
          });
        }
      });
    });

    if (UI.shouldUpdateHash) {
      UI.updateURL();
    }

    UI.storeCurrentCodeInLocalStorage()
  }

  UI.setCodeFromHash();

  UI.renderSettings();
  UI.fetchTooltips().then(() => {
    UI.renderSettings();
  });

  UI.downloadExamplesTOC()
  UI.openDropdownsOnLaunchIfNeeded()

  updateOutput();
  inputEditor.onDidChangeModelContent(() => {
    updateOutput();
  });
  UI.shouldUpdateHash = true;

  UI.renderAvailableVersions();

  // You already have these, it's just reaching into the require cache
  require(["vs/language/typescript/tsWorker"], () => {
    require(["vs/language/typescript/lib/typescriptServices"], () => {
      window.ts = ts
    })
  })

  /* Run */
  document.getElementById("run").onclick = () => runJavaScript()
  function runJavaScript() {
    console.clear();
    // to hide the stack trace
    const isJS = window.CONFIG.useJavaScript
    const model = isJS ? State.inputModel : State.outputModel
    setTimeout(() => {
      eval(model.getValue());
    }, 0);
  }

  // Add support for command clicking on example links
  const isJS = window.CONFIG.useJavaScript
  monaco.languages.registerLinkProvider(languageType({ isJS }), new ExampleHighlighter());

  inputEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runJavaScript)
  outputEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runJavaScript);
  inputEditor.addCommand(monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KEY_F, prettier);

  // if the focus is outside the editor
  window.addEventListener(
    "keydown",
    event => {
      const S_KEY = 83;
      if (event.keyCode == S_KEY && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();

        window.clipboard.writeText(location.href.toString()).then(
          () => UI.showFlashMessage("URL is copied to the clipboard!"),
          e => {
            alert(e);
          },
        );
      }

      if (
        event.keyCode === 13 &&
        (event.metaKey || event.ctrlKey) &&
        event.target instanceof Node &&
        event.target === document.body
      ) {
        event.preventDefault();
        runJavaScript();
      }
    },
    false,
  );

  function prettier() {
    const PRETTIER_VERSION = "1.14.3";

    require([
      `https://unpkg.com/prettier@${PRETTIER_VERSION}/standalone.js`,
      `https://unpkg.com/prettier@${PRETTIER_VERSION}/parser-typescript.js`,
    ], function(prettier, { parsers }) {
      const cursorOffset = State.inputModel.getOffsetAt(
        inputEditor.getPosition(),
      );

      const formatResult = prettier.formatWithCursor(
        State.inputModel.getValue(),
        {
          parser: parsers.typescript.parse,
          cursorOffset,
        },
      );

      State.inputModel.setValue(formatResult.formatted);
      const newPosition = State.inputModel.getPositionAt(
        formatResult.cursorOffset,
      );
      inputEditor.setPosition(newPosition);
    });
  }
}

class ExampleHighlighter {
  provideLinks(model, _cancelToken) {
    const text = model.getValue();

    // https://regex101.com/r/3uM4Fa/1
    const docRegexLink = /example:([^\s]+)/g;

    const links = [];

    let match
    while ((match = docRegexLink.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      const startPos = model.getPositionAt(start);
      const endPos = model.getPositionAt(end);

      const range = {
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column
      };

      const url = document.location.href.split("#")[0]
      links.push({
        url: url + "#example/" + match[1],
        range
      });
    }

    return { links };
  }
}



// http://stackoverflow.com/questions/1714786/ddg#1714899
function objectToQueryParams(obj) {
  const str = []
  for (var p in obj)
    if (obj.hasOwnProperty(p)) {
      str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
    }
  return str.join("&");
}


// Color theme:

const blue = "3771EF";
const darkerBlue = "1142AF";
const darkestBlue = "09235D";

const yellow = "F3DF51";
const darkYellow = "AEA811";
const darkerYellow = "65610A";

const grey = "84864d";
const green = "12CD0E";
const greenDark = "10990D";
const greenLight = "54F351";

const sandboxTheme = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "000000", background: "fffffe" },
    { token: "invalid", foreground: "cd3131" },
    { token: "emphasis", fontStyle: "italic" },
    { token: "strong", fontStyle: "bold" },

    { token: "variable", foreground: "11bb11" },
    { token: "variable.predefined", foreground: "4864AA" },
    { token: "constant", foreground: "44ee11" },
    { token: "comment", foreground: grey },
    { token: "number", foreground: greenDark },
    { token: "number.hex", foreground: "3030c0" },
    { token: "regexp", foreground: greenLight },
    { token: "annotation", foreground: "808080" },
    { token: "type", foreground: darkerBlue },

    { token: "delimiter", foreground: "000000" },
    { token: "delimiter.html", foreground: "383838" },
    { token: "delimiter.xml", foreground: "0000FF" },

    { token: "tag", foreground: "800000" },
    { token: "tag.id.pug", foreground: "4F76AC" },
    { token: "tag.class.pug", foreground: "4F76AC" },
    { token: "meta.scss", foreground: "800000" },
    { token: "metatag", foreground: "e00000" },
    { token: "metatag.content.html", foreground: "FF0000" },
    { token: "metatag.html", foreground: "808080" },
    { token: "metatag.xml", foreground: "808080" },
    { token: "metatag.php", fontStyle: "bold" },

    { token: "key", foreground: "863B00" },
    { token: "string.key.json", foreground: "A31515" },
    { token: "string.value.json", foreground: "0451A5" },

    { token: "attribute.name", foreground: "FFFF00" },
    { token: "attribute.value", foreground: "0451A5" },
    { token: "attribute.value.number", foreground: "09885A" },
    { token: "attribute.value.unit", foreground: "09885A" },
    { token: "attribute.value.html", foreground: "0000FF" },
    { token: "attribute.value.xml", foreground: "0000FF" },

    { token: "string", foreground: greenDark },

    { token: "keyword", foreground: blue },
    { token: "keyword.json", foreground: "0451A5" }
  ],
  colors: {
    editorBackground: "#F6F6F6",
    editorForeground: "#000000",
    editorInactiveSelection: "#E5EBF1",
    editorIndentGuides: "#D3D3D3",
    editorActiveIndentGuides: "#939393",
    editorSelectionHighlight: "#ADD6FF4D"
  }
};