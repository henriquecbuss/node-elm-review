const path = require('path');
const chokidar = require('chokidar');
const Debug = require('./debug');
const FS = require('./fs-wrapper');
const Runner = require('./runner');
const AppState = require('./state');
const Anonymize = require('./anonymize');
const OsHelpers = require('./os-helpers');
const SuppressedErrors = require('./suppressed-errors');

/**
 * @typedef { import("fs").FSWatcher } FSWatcher
 * @typedef { import("./types/options").Options } Options
 * @typedef { import("./types/watch").WatchOptions } WatchOptions
 * @typedef { import("./types/build").ReviewElmJson } ReviewElmJson
 * @typedef { import("./types/content").ElmJsonData } ElmJsonData
 * @typedef { import("./types/content").ElmFile } ElmFile
 * @typedef { import("./types/path").Path } Path
 */

let isFlushingStdio = false;

/**
 *
 * @param {Options} options
 * @param {WatchOptions} watchOptions
 * @param {() => void} rebuildAndRewatch
 * @param {(err: Error) => void} onError
 * @returns {void}
 */
function watchFiles(
  options,
  {
    app,
    elmJsonData,
    elmFiles,
    sourceDirectories,
    reviewElmJson,
    reviewElmJsonPath
  },
  rebuildAndRewatch,
  onError
) {
  AppState.filesWereUpdated(elmFiles);

  let elmJsonContent = elmJsonData.project;

  let runReview = () => {
    Runner.requestReview(options, app);
  };

  if (!isFlushingStdio) {
    // This makes sure that any stdin input is removed before prompting the user.
    // That way, when the user presses Enter in watch mode when there is no report yet,
    // a proposed fix will not automatically be applied.
    process.stdin.on('readable', () => {
      // Use a loop to make sure we read all available data.
      while (process.stdin.read() !== null) {
        // Do nothing
      }
    });
    isFlushingStdio = true;
  }

  const elmJsonWatcher = chokidar
    .watch(OsHelpers.makePathOsAgnostic(options.elmJsonPath), {
      ignoreInitial: true
    })
    .on('change', async () => {
      const newValue = await FS.readJsonFile(options.elmJsonPath);
      if (JSON.stringify(newValue) !== JSON.stringify(elmJsonContent)) {
        elmJsonContent = newValue;
        runReview = () => {};
        clearTimeout(suppressedErrorsTimeout);
        await Promise.all([
          elmJsonWatcher.close(),
          readmeWatcher && readmeWatcher.close(),
          fileWatcher.close(),
          suppressedErrorsWatcher.close(),
          configurationWatcher && configurationWatcher.close()
        ]);

        if (options.report !== 'json') {
          if (!options.debug) {
            clearConsole();
          }

          // TODO Detect what has changed and only re-load the necessary parts.
          // We do some of this work in `autofix.js` already.
          Debug.log('Your `elm.json` has changed. Restarting elm-review.');
        }

        rebuildAndRewatch();

        // At the moment, since a lot of things can change (elm.json properties, source-directories, dependencies, ...),
        // it is simpler to re-run the whole process like when the configuration changes.
        //
        // We could try and handle each possible change separately to make this more efficient.
        //
        // app.ports.collectElmJson.send(newValue);
        // const projectDeps = await projectDependencies.collect(
        //   options,
        //   newValue,
        //   elmVersion
        // );
        // app.ports.collectDependencies.send(projectDeps);
        // runReview();
      }
    });

  const readmeWatcher =
    options.readmePath === null
      ? null
      : ((readmePath) =>
          chokidar
            .watch(OsHelpers.makePathOsAgnostic(readmePath), {
              ignoreInitial: true
            })
            .on('add', async () => {
              Debug.log('README.md has been added');

              const readme = {
                path: readmePath,
                content: await FS.readFile(readmePath)
              };

              AppState.readmeChanged(readme);
              app.ports.collectReadme.send(readme);
              runReview();
            })
            .on('change', async () => {
              const readme = {
                path: readmePath,
                content: await FS.readFile(readmePath)
              };
              const readmeHasChanged = AppState.readmeChanged(readme);
              if (readmeHasChanged) {
                Debug.log('README.md has been changed');

                app.ports.collectReadme.send(readme);
                runReview();
              }
            })
            .on('error', onError))(options.readmePath);

  const fileWatcher = chokidar
    .watch(
      sourceDirectories.map(
        /**
         * @param {Path} directory
         * @returns {string} glob
         */
        (directory) => OsHelpers.makePathOsAgnostic(`${directory}/**/*.elm`)
      ),
      {
        ignored: [
          'node_modules',
          'elm-stuff',
          '.*',
          '**/ElmjutsuDumMyM0DuL3.elm'
        ],
        ignoreInitial: true
      }
    )
    .on('add', async (absolutePath) => {
      const relativePath = OsHelpers.makePathOsAgnostic(
        path.relative(process.cwd(), absolutePath)
      );

      Debug.log(`File ${Anonymize.path(options, relativePath)} has been added`);

      let elmFile = AppState.getFileFromMemoryCache(relativePath);

      const isNewFile = !elmFile;

      if (!elmFile) {
        elmFile = {
          path: relativePath,
          source: '',
          ast: null
        };
      }

      const newSource = await FS.readFile(relativePath);

      if (elmFile.source !== newSource) {
        // NOTE: Mutates the file cache
        elmFile.source = newSource;
        elmFile.ast = null;
      }

      if (isNewFile) {
        AppState.filesWereUpdated([elmFile]);
      }

      app.ports.collectFile.send(elmFile);
      runReview();
    })
    .on('change', async (absolutePath) => {
      const relativePath = OsHelpers.makePathOsAgnostic(
        path.relative(process.cwd(), absolutePath)
      );

      let elmFile = AppState.getFileFromMemoryCache(relativePath);
      if (!elmFile) {
        elmFile = {
          path: relativePath,
          source: '',
          ast: null
        };
      }

      const newSource = await FS.readFile(relativePath);

      if (elmFile.source !== newSource) {
        Debug.log(
          `File ${Anonymize.path(options, relativePath)} has been changed`
        );

        // NOTE: Mutates the file cache
        elmFile.source = newSource;
        elmFile.ast = null;
        app.ports.collectFile.send(elmFile);
        runReview();
      }
    })
    .on('unlink', (absolutePath) => {
      const relativePath = OsHelpers.makePathOsAgnostic(
        path.relative(process.cwd(), absolutePath)
      );
      Debug.log(
        `File ${Anonymize.path(options, relativePath)} has been removed`
      );

      app.ports.removeFile.send(relativePath);
      runReview();
    })
    .on('error', onError);

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let suppressedErrorsTimeout;

  function updateSuppressedErrors() {
    // TODO Write last save time for each of these in appstate, and compare with the last update time
    // that is given as argument to this function. If possible, don't do anything.
    if (suppressedErrorsTimeout) {
      clearTimeout(suppressedErrorsTimeout);
    }

    suppressedErrorsTimeout = setTimeout(async () => {
      const suppressedErrors = await SuppressedErrors.read(options);
      // TODO Avoid doing anything if suppressed errors haven't changed
      //    It's likely this program's fault for changing anything anyway
      Debug.log('Suppressed errors have been added');
      app.ports.updateSuppressedErrors.send(suppressedErrors);
    }, 20);
  }

  const suppressedErrorsWatcher = chokidar
    .watch(
      OsHelpers.makePathOsAgnostic(
        `${options.suppressedErrorsFolder()}/*.json`
      ),
      {ignoreInitial: true}
    )
    .on('add', updateSuppressedErrors)
    .on('change', updateSuppressedErrors)
    .on('unlink', updateSuppressedErrors)
    .on('error', onError);

  const configurationWatcher = watchConfiguration(
    options,
    reviewElmJson,
    reviewElmJsonPath,
    async () => {
      runReview = () => {};

      clearTimeout(suppressedErrorsTimeout);
      await Promise.all([
        elmJsonWatcher.close(),
        readmeWatcher && readmeWatcher.close(),
        fileWatcher.close(),
        suppressedErrorsWatcher.close()
      ]);

      rebuildAndRewatch();
    }
  );
}

/**
 * @param {Options} options
 * @param {ReviewElmJson} reviewElmJson
 * @param {Path} reviewElmJsonPath
 * @param {() => void} rebuildAndRewatch
 * @returns {FSWatcher | undefined} Function to close the watcher
 */
function watchConfiguration(
  options,
  reviewElmJson,
  reviewElmJsonPath,
  rebuildAndRewatch
) {
  if (!reviewElmJsonPath || !options.watchConfig) return;

  const configurationPaths = reviewElmJson['source-directories']
    .map(
      /**
       * @param {Path} directory
       * @returns {string}
       */
      (directory) => path.resolve(options.userSrc(), directory) + '/**/*.elm'
    )
    .concat([reviewElmJsonPath])
    .map(OsHelpers.makePathOsAgnostic);

  const configurationWatcher = chokidar
    .watch(configurationPaths, {ignoreInitial: true})
    .on('change', async () => {
      await configurationWatcher.close();

      if (options.report !== 'json') {
        if (!options.debug) {
          clearConsole();
        }

        console.log(
          'Your configuration has changed. Restarting elm-review with the new one.'
        );
      }

      rebuildAndRewatch();
    });

  return configurationWatcher;
}

function clearConsole() {
  process.stdout.write(
    process.platform === 'win32'
      ? '\u001B[2J\u001B[0f'
      : '\u001B[2J\u001B[3J\u001B[H'
  );
}

module.exports = {
  watchFiles,
  watchConfiguration
};
