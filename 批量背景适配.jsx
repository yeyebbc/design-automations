/*
Batch background adaptation for AI files listed in a TXT file.

For each listed .ai file (one path per line; lines are trimmed, empty lines
are ignored, a UTF-8 BOM on the first line is tolerated):
  1. open the Illustrator document
  2. find the bottom-most effectively visible artwork object (stacking
     order, not canvas position; an object counts as visible only when it
     itself, its containing groups, and its containing layers are visible)
  3. inspect that exact object's name: it must contain "background" or "bg"
     (case-insensitive); otherwise the file is skipped
  4. RasterItem and MeshItem backgrounds are skipped
  5. before resizing, hide any other art objects whose shape exactly matches
     the detected background (same geometry point-for-point, no rotation,
     and geometric bounds within 2 pt of the background's in both
     directions); when the detected background is a GroupItem, use its own
     clipping mask as the geometry reference and hide only other matching
     clipping masks, never the mask inside the background group itself
  6. resize the detected background object to 1000% x 1000% from its center
     (Transformation.CENTER); the original artwork is reused, never rebuilt
  7. wrap the enlarged background in a clipping group whose clipping path
     exactly matches the active artboard, so the enlarged background cannot
     spill onto neighboring artboards
  8. hide art objects (and layers) named "highlight" or "overlay"
     (case-insensitive), so highlight/overlay artwork is not present in
     the adapted output
  9. save the modified document as a NEW .ai file in the output folder
  10. close the document without saving changes (the source file is never
     overwritten)
  11. record the result in the batch log and, only after a clean close, in a
      persistent completion file used for crash-safe resume

This script performs NO image export; that is a separate later stage.

The background name rule normally inspects the bottom-most object's own
name. When that object is a clipped GroupItem, its own top-most direct
clipping mask may carry the "Background"/"bg" name instead; that mask name
is accepted while the whole group remains the background object. An optional
layer-name fallback also exists (see the allowLayerNameMatch setting below).

Counters (see also the log summary):
  fileCount     - number of non-empty entries read from the TXT list
  fileProcessed - every TXT entry for which processing was attempted,
                  including entries whose source file is missing or invalid
                  (this implementation: fileProcessed == fileCount)
  fileSkipped   - entries that did not produce a completed output file
  fileDone      - entries with a verified completed output, either completed
                  in this run or resumed from an earlier completion record
  fileResumed   - subset of fileDone skipped because a verified completion
                  record and its output file already existed
Consistency: fileCount == fileProcessed == fileSkipped + fileDone
*/

(function () {
    // Note 1: This immediately invoked function expression keeps helper names out of the global scope.
    // Note 2: Illustrator ExtendScript shares one global engine, so global name isolation prevents collisions.
    // Note 3: The app object is supplied by Illustrator and is not a browser or Node.js API.
    // Note 4: ExtendScript is based on an older JavaScript dialect, so this file uses var instead of let.
    // Note 5: Function declarations are hoisted, which lets earlier workflow code call helpers defined later.
    // Note 6: $.fileName is an ExtendScript host value containing the path of the running JSX file.
    // Note 7: File and Folder are ExtendScript objects that wrap filesystem paths and operations.
    // Note 8: Using the script folder as the root makes the batch portable between mounted locations.
    // Note 9: Unicode escape sequences keep configured Chinese names stable across script editors.
    // Note 10: Configuration values are grouped near the top so behavior changes remain easy to audit.
    // Note 11: Host settings must be captured before mutation so the outer finally block can restore them.
    // Note 12: Mutable counters are intentionally batch scoped because many helpers update shared results.
    // Note 13: This design favors explicit state over classes because ExtendScript host objects are fragile.
    // Note 14: A File object can exist even when its target does not, so .exists must be checked separately.
    // Note 15: fsName asks ExtendScript for the native path representation used by the current platform.
    // Note 16: Forward slash normalization later creates stable keys across Windows and macOS path syntax.
    // Note 17: User interaction is disabled only during the run to prevent modal dialogs from blocking automation.
    // Note 18: Native Illustrator failures can terminate the process before JavaScript catch blocks execute.
    // Note 19: Durable files and stage logs therefore provide stronger recovery than in-memory state alone.
    // Note 20: The top-level closure ends with one coordinated cleanup path for predictable host restoration.
    var oldInteractionLevel = app.userInteractionLevel;
    var scriptFile = new File($.fileName);
    var scriptFolder = scriptFile.parent;

    // ---- Configuration (edit these to match your run) --------------------
    // The TXT list of .ai file paths to process, one path per line.
    var listFileName = "\u6587\u4EF6\u5217\u8868.txt";           // 文件列表.txt
    // New .ai files are saved into this folder (relative to the script).
    var outputFolderName = "\u80CC\u666F\u9002\u914D";           // 背景适配
    // Batch log file name prefix; a timestamp is appended per run.
    var logPrefix = "\u80CC\u666F\u9002\u914D\u65E5\u5FD7";      // 背景适配日志
    // Persistent records written only after saveAs and a clean close. A later
    // run skips a source only when both its record and output file exist.
    var completionFileName = "\u80CC\u666F\u9002\u914D\u5B8C\u6210\u8BB0\u5F55.txt"; // 背景适配完成记录.txt
    // Optional pauses around document transitions (one after saveAs, one
    // after close). They reduce pressure on Illustrator's asynchronous
    // renderer but cannot prevent native crashes. Default 0: two 300 ms waits
    // per file cost ~45 minutes of pure waiting on a 4500-file batch, and the
    // per-session restart limit below already bounds memory growth. Raise this
    // if you observe save/render instability within a single session.
    var nativeSettleDelayMs = 0;
    // Position tolerance (points) for same-shape matching: a candidate object
    // must have geometric bounds within this distance of the background in
    // both directions to be treated as the same shape (rotation is never
    // allowed).
    var sameShapePositionTolerance = 2;
    // Strict name rule by default: the bottom-most visible object's OWN name
    // must contain "background" or "bg". Set to true to also accept the object
    // when its containing LAYER name contains "background" or "bg" (typical
    // for files whose background art lives in a "Background" layer while the
    // art objects themselves are unnamed).
    var allowLayerNameMatch = false;
    // Per-session restart limit: Illustrator's native memory grows with every
    // open/close cycle and is never fully reclaimed, which eventually crashes
    // the process (observed at file ~274 on a 4500-file run). Processing stops
    // after this many documents have been opened in the current session; the
    // script writes a restart marker and quits, and the launcher script
    // restarts Illustrator so the batch resumes via completion records.
    var maxFilesPerSession = 200;
    // Restart marker file (in the script folder). Its content is "CONTINUE"
    // when the session limit was reached (Illustrator should restart), or
    // "DONE" when every listed file already has a verified completed output.
    // ASCII name avoids macOS filename-encoding divergence between the
    // Illustrator ExtendScript host and shell/driver processes: on this
    // system the same Chinese filename produced distinct byte sequences
    // ("批次游标.txt" vs a mojibake variant), so a marker written by JSX
    // could not be read back by the shell launcher. ASCII has one encoding.
    var restartMarkerFileName = "batch-restart.txt";
    // ---------------------------------------------------------------------

    var listFile = new File(scriptFolder.fsName + "/" + listFileName);
    var outputFolder = new Folder(scriptFolder.fsName + "/" + outputFolderName);
    var completionFile = new File(outputFolder.fsName + "/" + completionFileName);

    var logPath = null;
    var restartMarker = new File(scriptFolder.fsName + "/" + restartMarkerFileName);
    var sessionProcessed = 0;  // 本会话真正打开文档的条目数(恢复跳过不计入)
    var shouldQuit = false;    // 达到会话上限后置位;主循环结束时退出 Illustrator
    var fastForwarded = 0;     // 本会话按完成记录静默跳过的条目数

    // Batch counters.
    var fileCount = 0;       // valid non-empty entries read from the TXT list
    var fileProcessed = 0;   // entries for which processing was attempted
    var fileSkipped = 0;     // entries that did not produce a completed output
    var fileDone = 0;        // entries with verified completed outputs
    var fileResumed = 0;     // fileDone entries reused from prior completion records

    var startTime = null;

    function pad2(n) {
        return n < 10 ? "0" + n : "" + n;
    }

    function nowText(date) {
        var d = date || new Date();
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
            " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function timestampCompact(date) {
        var d = date || new Date();
        return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
            "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    function formatDuration(ms) {
        var totalSeconds = Math.floor(ms / 1000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
    }

    /*
    Logging keeps one handle open between native calls and commits buffered
    writes at the boundaries where a native crash could destroy evidence
    (app.open / saveAs / doc.close). ExtendScript has no File.flush(), so a
    commit is close() followed by reopen in append mode; log() reopens lazily
    if a later line arrives. Every line written so far survives a native
    crash; the summary is written in the outermost finally block.
    */
    // Note 21: Logging is treated as an observability feature, not as part of the artwork transaction.
    // Note 22: A null logPath means startup could not reserve a writable log file.
    // Note 23: Returning silently keeps a logging failure from stopping production work.
    // Note 24: UTF-8 is assigned before opening because ExtendScript stores encoding on the File object.
    // Note 25: Append mode preserves earlier lines while adding one new durable event.
    // Note 26: Keeping one handle open avoids tens of thousands of redundant opens per batch.
    // Note 27: flushLog commits at the few boundaries where a native crash can destroy evidence.
    // Note 28: writeln adds the platform line ending and avoids manual newline concatenation.
    // Note 29: close commits buffered output; closeLog closes once at the end of the session.
    // Note 30: The empty catch is deliberate because diagnostics must never become a new failure source.
    // Note 31: Stage begin and done pairs later identify the exact host operation that did not return.
    // Note 32: Plain text logs remain readable even when Illustrator cannot start on the next run.
    // Note 33: A timestamped filename preserves evidence from separate sessions instead of overwriting it.
    // Note 34: The output folder is preferred so artifacts from one batch stay together.
    // Note 35: The script folder is a fallback for cases where output folder creation fails.
    // Note 36: Reserving the file with write mode detects permission problems before processing begins.
    // Note 37: The handle stays open after reservation; closeLog closes it at the end.
    // Note 38: flushLog closes the handle at native boundaries; no handle stays open across them.
    // Note 39: log() reopens in append mode on demand, so handles never linger on NAS or cloud volumes.
    // Note 40: closeLog is still defensive because an unexpected branch may leave a handle open.
    function log(message) {
        if (logPath === null) {
            return;
        }
        try {
            logPath.encoding = "UTF-8";
            if (!logPath.opened && !logPath.open("a")) {
                return;
            }
            logPath.writeln(message);
        } catch (e) {
            // Logging must never stop the batch.
        }
    }

    // Keep the log handle open between native calls and commit buffered
    // writes at the boundaries where a native crash could destroy evidence.
    // ExtendScript has no File.flush(); close() commits, so a commit is a
    // close followed by an append-mode reopen. log() reopens lazily if a
    // later line arrives. The old per-line open()/close() pattern cost two
    // filesystem opens per log line - tens of thousands of redundant opens
    // over a large batch - for the same durability as this.
    function flushLog() {
        if (logPath === null || !logPath.opened) {
            return;
        }
        try {
            logPath.close();
            logPath.open("a");
        } catch (e) {
            // Logging must never stop the batch.
        }
    }

    function openLog() {
        // Unique run-oriented name so previous logs are never overwritten.
        var name = logPrefix + "-" + timestampCompact(startTime) + ".txt";
        var candidates = [new File(scriptFolder.fsName + "/" + name)];
        try {
            ensureFolder(outputFolder);
            candidates.unshift(new File(outputFolder.fsName + "/" + name));
        } catch (e) {
            // Fall back to the script folder below.
        }
        for (var i = 0; i < candidates.length; i++) {
            try {
                var f = candidates[i];
                f.encoding = "UTF-8";
                if (f.open("w")) {   // create/truncate to reserve the name
                    logPath = f;     // handle stays open; closeLog closes it
                    return;
                }
            } catch (e) {
                // Try the next candidate.
            }
        }
        logPath = null;
    }

    function closeLog() {
        try {
            if (logPath !== null && logPath.opened) {
                logPath.close(); // close commits buffered output
            }
        } catch (e) {}
        logPath = null;
    }

    // Restart marker protocol: read/write batch-restart.txt so the external
    // launcher knows whether to start another Illustrator session. Marker
    // failures are non-fatal; without a marker the batch simply continues
    // inside whatever session is running.
    function readRestartMarker() {
        try {
            if (restartMarker.exists && restartMarker.open("r")) {
                var line = trimText(stripBom(restartMarker.readln()));
                restartMarker.close();
                return line;
            }
        } catch (e) {
            // Marker problems are not fatal; treat as absent.
        }
        return null;
    }

    function writeRestartMarker(state) {
        try {
            restartMarker.encoding = "UTF-8";
            restartMarker.open("w");
            // write (not writeln) keeps the marker byte-exact: a trailing
            // platform line ending here would break the shell launcher's
            // exact "CONTINUE"/"DONE" string comparison.
            restartMarker.write(state);
            restartMarker.close();
            return true;
        } catch (e) {
            log("ERROR failed to write restart marker: " + e);
            return false;
        }
    }

    function trimText(s) {
        return String(s).replace(/^\s+|\s+$/g, "");
    }

    function stripBom(s) {
        if (s && s.length > 0 && s.charCodeAt(0) === 0xFEFF) {
            return s.substring(1);
        }
        return s;
    }

    // Note 41: Input parsing is kept separate from document processing so malformed lists fail early.
    // Note 42: The parser returns an array in source order because batch order is a user-visible contract.
    // Note 43: Empty lines are ignored rather than counted as failed files.
    // Note 44: stripBom handles text files written by Windows PowerShell with a UTF-8 BOM.
    // Note 45: trimText removes accidental spaces around paths without changing spaces inside filenames.
    // Note 46: readln avoids loading a potentially large list into one temporary string.
    // Note 47: eof is a File property provided by ExtendScript, not the standard JavaScript language.
    // Note 48: Explicit encoding prevents localized systems from interpreting UTF-8 paths as legacy text.
    // Note 49: A missing list is logged once and represented by an empty result.
    // Note 50: The caller can then produce a consistent summary instead of crashing at startup.
    // Note 51: File.open returns a Boolean, but this older function relies on exceptions and later reads.
    // Note 52: The catch closes an opened handle to avoid leaking descriptors into a long Illustrator run.
    // Note 53: The nested cleanup catch protects against errors raised while handling the first error.
    // Note 54: Path validation is delayed until each item so the log can explain every invalid entry.
    // Note 55: The .ai extension check is case insensitive for cross-platform compatibility.
    // Note 56: Backslashes are normalized before checking the suffix because Windows paths may appear.
    // Note 57: ensureFolder performs an idempotent create operation: existing folders are left untouched.
    // Note 58: Failure to create the output directory is fatal because safe Save As would be impossible.
    // Note 59: Throwing from ensureFolder lets the caller choose whether the failure is batch or file scoped.
    // Note 60: Small parsing helpers make filesystem assumptions explicit and independently reviewable.
    function readFileList(fileObj) {
        var result = [];
        if (!fileObj.exists) {
            log("ERROR list file not found: " + fileObj.fsName);
            return result;
        }
        try {
            fileObj.encoding = "UTF-8";
            fileObj.open("r");
            while (!fileObj.eof) {
                var line = fileObj.readln();
                line = trimText(stripBom(line));
                if (line !== "") {
                    result.push(line);
                }
            }
            fileObj.close();
        } catch (e) {
            log("ERROR failed to read list file: " + e);
            try {
                if (fileObj.opened) {
                    fileObj.close();
                }
            } catch (ignore) {}
        }
        return result;
    }

    function ensureFolder(folderObj) {
        if (!folderObj.exists) {
            if (!folderObj.create()) {
                throw new Error("Cannot create folder: " + folderObj.fsName);
            }
        }
    }

    function isAiFilePath(path) {
        return /\.ai$/i.test(String(path).replace(/\\/g, "/"));
    }

    function normalizedFsName(fileObj) {
        return String(fileObj.fsName).replace(/\\/g, "/");
    }

    function completionKey(fileObj) {
        // Prefixing prevents a path from colliding with Object prototype names.
        return "$" + encodeURIComponent(normalizedFsName(fileObj));
    }

    // Note 61: Resume keys identify source paths, while record values identify verified output paths.
    // Note 62: encodeURIComponent escapes tabs and path punctuation before data is stored in a TSV line.
    // Note 63: A leading dollar sign prevents a path from matching inherited Object property names.
    // Note 64: Plain objects are used as hash maps because ES3 ExtendScript does not provide Map.
    // Note 65: The Boolean true value makes membership checks explicit rather than relying on truthy paths.
    // Note 66: new File normalizes each user path through the same completionKey function.
    // Note 67: Requested keys limit expensive filesystem checks to sources in the current batch.
    // Note 68: This matters when an old completion file contains thousands of NAS and cloud paths.
    // Note 69: Reading irrelevant text records is cheap compared with stat calls on disconnected mounts.
    // Note 70: Filtering before decode and File.exists avoids accidental network access.
    // Note 71: Completion records are append only so a crash cannot corrupt earlier successful entries.
    // Note 72: Duplicate records are harmless because assigning the same key replaces the map value.
    // Note 73: A record alone is not trusted because saveAs may have been followed by file deletion.
    // Note 74: Output existence is rechecked before a source can be marked as resumed.
    // Note 75: Source existence is checked later by processOneFile because resume may skip opening it.
    // Note 76: Stable path normalization is essential when the same list is generated on another platform.
    // Note 77: A moved source intentionally receives a new key and is processed as a different input.
    // Note 78: A moved output invalidates the old record and causes a safe new output to be created.
    // Note 79: This conservative policy favors correctness over aggressive path guessing.
    // Note 80: The requested-key set scopes legacy migration checks to sources in the current run.
    function buildRequestedCompletionKeys(paths) {
        var requested = {};
        for (var i = 0; i < paths.length; i++) {
            requested[completionKey(new File(paths[i]))] = true;
        }
        return requested;
    }

    // Note 81: Completion loading is a validation pass, not a blind deserialization step.
    // Note 82: staleCount aggregates warnings so one bad record does not cause one slow log write.
    // Note 83: malformedCount separates encoding or format problems from missing output files.
    // Note 84: Missing completion storage is a normal first-run condition and returns an empty map.
    // Note 85: Each nonempty line is split on tabs because encoded paths cannot contain raw tabs.
    // Note 86: The DONE token is a simple schema version guard for unrelated or partial lines.
    // Note 87: Fields beyond index two can be added later without breaking this minimum parser.
    // Note 88: Membership is checked before decodeURIComponent to avoid work for unrelated records.
    // Note 89: Membership is also checked before File.exists to prevent slow remote path probes.
    // Note 90: recordedOutput.exists verifies that the durable artifact still exists now.
    // Note 91: A valid record is stored under the encoded source key for constant-time lookup.
    // Note 92: A stale record remains on disk for audit history but is ignored for resume.
    // Note 93: Malformed relevant records are counted and ignored rather than stopping the batch.
    // Note 94: The entire read is wrapped because mounted volumes can disappear during iteration.
    // Note 95: The recovery close uses fileObj.opened so it does not reopen a failed file.
    // Note 96: Aggregated warnings are emitted after the record handle is closed.
    // Note 97: Closing first avoids nested open and close traffic on the same remote directory.
    // Note 98: The returned object contains only records proven relevant and currently usable.
    // Note 99: processOneFile treats presence in this object as permission to skip app.open.
    // Note 100: This boundary keeps recovery logic independent from Illustrator document logic.
    function readCompletionRecords(fileObj, requestedKeys) {
        var completed = {};
        var staleCount = 0;
        var malformedCount = 0;
        if (!fileObj.exists) {
            return completed;
        }
        try {
            fileObj.encoding = "UTF-8";
            if (!fileObj.open("r")) {
                log("WARN could not open completion records: " + fileObj.fsName);
                return completed;
            }
            while (!fileObj.eof) {
                var line = trimText(stripBom(fileObj.readln()));
                if (line === "") {
                    continue;
                }
                var parts = line.split("\t");
                if (parts.length < 3 || parts[0] !== "DONE") {
                    continue;
                }

                // A completion file can contain thousands of records from
                // earlier runs and other mount points. Only records relevant
                // to the current input list may trigger filesystem checks;
                // probing every stale NAS/cloud path can block Illustrator for
                // minutes before the first source document is opened.
                if (requestedKeys[parts[1]] !== true) {
                    continue;
                }

                try {
                    var outputPath = decodeURIComponent(parts[2]);
                    var recordedOutput = new File(outputPath);
                    if (recordedOutput.exists) {
                        completed[parts[1]] = normalizedFsName(recordedOutput);
                    } else {
                        staleCount++;
                    }
                } catch (recordError) {
                    malformedCount++;
                }
            }
            fileObj.close();
        } catch (e) {
            log("WARN failed to read completion records: " + e);
            try { if (fileObj.opened) { fileObj.close(); } } catch (ignore) {}
        }
        if (staleCount > 0) {
            log("WARN ignored " + staleCount +
                " stale completion record(s) relevant to the current input list.");
        }
        if (malformedCount > 0) {
            log("WARN ignored " + malformedCount +
                " malformed completion record(s) relevant to the current input list.");
        }
        return completed;
    }

    function hasMissingRequestedCompletion(requestedKeys, completed) {
        for (var key in requestedKeys) {
            if (requestedKeys[key] === true && completed[key] === undefined) {
                return true;
            }
        }
        return false;
    }

    function importLegacyCompletionRecords(folderObj, completed, recordFile, requestedKeys) {
        var imported = 0;
        var logs = [];
        try {
            logs = folderObj.getFiles(logPrefix + "-*.txt");
        } catch (listError) {
            log("WARN could not scan legacy logs for resume records: " + listError);
            return imported;
        }

        for (var i = 0; i < logs.length; i++) {
            var legacyLog = logs[i];
            if (!(legacyLog instanceof File)) {
                continue;
            }
            var currentSource = null;
            var statusDone = false;
            try {
                legacyLog.encoding = "UTF-8";
                if (!legacyLog.open("r")) {
                    continue;
                }
                while (!legacyLog.eof) {
                    var line = trimText(stripBom(legacyLog.readln()));
                    var header = line.match(/^\[\d+\/\d+\]\s+(.+)$/);
                    if (header !== null) {
                        currentSource = header[1];
                        statusDone = false;
                        continue;
                    }
                    if (line === "Status: DONE") {
                        statusDone = true;
                        continue;
                    }
                    if (statusDone && currentSource !== null && line.indexOf("Output: ") === 0) {
                        var sourceFile = new File(currentSource);
                        var key = completionKey(sourceFile);
                        if (requestedKeys[key] === true) {
                            var outputFile = new File(line.substring(8));
                            if (sourceFile.exists && outputFile.exists && completed[key] === undefined) {
                                completed[key] = normalizedFsName(outputFile);
                                if (appendCompletionRecord(recordFile, sourceFile, outputFile)) {
                                    imported++;
                                }
                            }
                        }
                        statusDone = false;
                    }
                }
                legacyLog.close();
            } catch (e) {
                log("WARN failed to import legacy log " + legacyLog.fsName + ": " + e);
                try { if (legacyLog.opened) { legacyLog.close(); } } catch (ignore) {}
            }
        }
        if (imported > 0) {
            log("Resume: imported " + imported + " verified completion record(s) from earlier logs.");
        }
        return imported;
    }

    function appendCompletionRecord(fileObj, sourceFile, outputFile) {
        try {
            fileObj.encoding = "UTF-8";
            if (!fileObj.open("a")) {
                log("WARN could not append completion record: " + fileObj.fsName);
                return false;
            }
            fileObj.writeln(
                "DONE\t" + completionKey(sourceFile) + "\t" +
                encodeURIComponent(normalizedFsName(outputFile))
            );
            fileObj.close();
            return true;
        } catch (e) {
            log("WARN failed to append completion record: " + e);
            try { if (fileObj.opened) { fileObj.close(); } } catch (ignore) {}
            return false;
        }
    }

    function logStage(sequence, total, path, stage, state) {
        log("STAGE [" + sequence + "/" + total + "] " + stage + " " + state +
            " | source=" + path);
    }

    function settleAfterNativeOperation(sequence, total, path, stage) {
        if (nativeSettleDelayMs <= 0) {
            return;
        }
        logStage(sequence, total, path, stage, "begin");
        $.sleep(nativeSettleDelayMs);
        logStage(sequence, total, path, stage, "done");
    }

    // Note 101: Output naming is intentionally deterministic before collision handling is applied.
    // Note 102: pathBaseName accepts both slash styles because lists may move between operating systems.
    // Note 103: lastIndexOf avoids depending on host-specific path parsing libraries.
    // Note 104: The final extension is removed without changing dots that are part of the base name.
    // Note 105: sanitizeFileName replaces characters forbidden by common Windows and macOS filesystems.
    // Note 106: Sanitizing twice also cleans a caller-provided fallback name.
    // Note 107: trimText prevents filenames made only from spaces or trailing separators.
    // Note 108: The final untitled fallback guarantees that Save As always receives a nonempty name.
    // Note 109: getUniqueAiFile checks both names chosen in memory and files already on disk.
    // Note 110: Disk checks protect crash leftovers that were saved before a completion record existed.
    // Note 111: The lowercase key provides case-insensitive collision handling on mixed filesystems.
    // Note 112: Prefixing the map key again avoids inherited Object names such as constructor.
    // Note 113: Numbering starts at two because the unsuffixed filename is the preferred first choice.
    // Note 114: The loop creates a fresh File object after every candidate name change.
    // Note 115: Existing output files are never overwritten, even when their completion record is stale.
    // Note 116: The chosen name is reserved in usedNames before the function returns.
    // Note 117: Reservation prevents two different source paths with the same base name from colliding.
    // Note 118: This function does not create the output file; saveAs performs that operation later.
    // Note 119: Delaying creation avoids empty files for documents skipped during validation.
    // Note 120: Naming policy is isolated so future suffix rules do not touch artwork processing.
    function pathBaseName(path) {
        var normalized = String(path).replace(/\\/g, "/");
        var idx = normalized.lastIndexOf("/");
        var name = (idx >= 0) ? normalized.substring(idx + 1) : normalized;
        return name.replace(/\.[^\.]+$/, "");
    }

    function sanitizeFileName(name, fallbackName) {
        var cleaned = String(name).replace(/[\\\/:\*\?"<>\|]/g, "_");
        cleaned = trimText(cleaned);
        if (cleaned === "") {
            cleaned = fallbackName;
        }
        cleaned = String(cleaned).replace(/[\\\/:\*\?"<>\|]/g, "_");
        cleaned = trimText(cleaned);
        if (cleaned === "") {
            cleaned = "untitled";
        }
        return cleaned;
    }

    function getUniqueAiFile(folderObj, baseName, usedNames) {
        var safeBase = sanitizeFileName(baseName, "untitled");
        var candidate = safeBase + ".ai";
        var index = 2;
        var key = candidate.toLowerCase();

        var candidateFile = new File(folderObj.fsName + "/" + candidate);
        while (usedNames["$" + key] || candidateFile.exists) {
            candidate = safeBase + "_" + index + ".ai";
            key = candidate.toLowerCase();
            candidateFile = new File(folderObj.fsName + "/" + candidate);
            index++;
        }

        usedNames["$" + key] = true;
        return candidateFile;
    }

    /*
    An object is "effectively visible" only when it, every ancestor group,
    and every containing layer are all visible. Checking item.hidden alone
    is not sufficient.
    */
    // Note 121: Illustrator visibility is inherited through groups and layers rather than stored once.
    // Note 122: A visible child inside a hidden parent is not effectively visible on the canvas.
    // Note 123: Walking parent links models this inherited state directly.
    // Note 124: Layers expose visible, while ordinary page items commonly expose hidden.
    // Note 125: Property access is guarded because different Illustrator DOM types expose different fields.
    // Note 126: A property error returns false so uncertain artwork is never selected as the background.
    // Note 127: The walk stops at Document or Application because higher objects do not affect artwork state.
    // Note 128: The stacking search iterates from the last collection index toward zero.
    // Note 129: Illustrator pageItems use index zero for the top of the stacking order.
    // Note 130: Therefore the last visible sibling is the visually bottom-most candidate.
    // Note 131: Layer order follows the same top-to-bottom collection convention.
    // Note 132: Groups occupy one stacking slot even though layer.pageItems may expose their descendants.
    // Note 133: isInsideGroup filters flattened descendants so the outer group remains the candidate.
    // Note 134: Parent traversal is safer than assuming layer.pageItems contains direct children only.
    // Note 135: Sublayers are searched bottom first only after direct page items are exhausted.
    // Note 136: Returning the first match preserves the exact stacking rule without name-based searching.
    // Note 137: Name validation happens after detection so matching names higher in the stack are ignored.
    // Note 138: This separation prevents a convenient name from replacing the true bottom object.
    // Note 139: null is used as an explicit no-candidate sentinel in this ES3-compatible code.
    // Note 140: The visibility helpers are read only and do not mutate document state.
    function isEffectivelyVisible(item) {
        var current = item;
        while (current) {
            try {
                if (current.typename === "Layer") {
                    if (current.visible === false) {
                        return false;
                    }
                }
                if (current.hidden === true) {
                    return false;
                }
            } catch (e) {
                return false;
            }
            if (current.typename === "Document" || current.typename === "Application") {
                break;
            }
            current = current.parent;
        }
        return true;
    }

    /*
    Finds the bottom-most effectively visible artwork object in stacking
    order. Illustrator collections are ordered top (index 0) to bottom
    (last index), so we walk from the last index upward. Groups occupy a
    single stacking slot: if the bottom-most visible object is a group, the
    group itself is the detected object (its name is inspected).
    */
    function findBottomMostVisibleItem(doc) {
        for (var li = doc.layers.length - 1; li >= 0; li--) {
            var layer = doc.layers[li];
            if (!isEffectivelyVisible(layer)) {
                continue;
            }
            var found = findBottomMostVisibleInLayer(layer);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }

    /*
    True when the item is nested inside a group (has a GroupItem ancestor
    before reaching the containing layer). Guards against flattened pageItems
    collections so a bottom-most group is detected as the group itself and
    never as one of its children.
    */
    function isInsideGroup(item) {
        var current = item.parent;
        while (current && current.typename !== "Layer") {
            if (current.typename === "GroupItem") {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    function findBottomMostVisibleInLayer(layer) {
        var items = layer.pageItems;
        for (var i = items.length - 1; i >= 0; i--) {
            var item = items[i];
            if (isInsideGroup(item)) {
                continue;
            }
            if (isEffectivelyVisible(item)) {
                return item;
            }
        }
        // Sublayers (nested layers), bottom-most first.
        var subs = layer.layers;
        for (var s = subs.length - 1; s >= 0; s--) {
            var sub = subs[s];
            if (!isEffectivelyVisible(sub)) {
                continue;
            }
            var found = findBottomMostVisibleInLayer(sub);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }

    function isBackgroundItem(item) {
        return /(background|bg)/i.test(String(item.name));
    }

    /*
    Error 8705 "Target layer cannot be modified" fires when CREATING new
    artwork while any layer in the document is locked or hidden (the layer
    reads unlocked, yet creation still fails). The documented remedy: make
    every layer/group/item visible and unlocked while editing, then restore
    the original state afterwards, so the saved file keeps the author's
    settings.
    */
    // Note 141: Unlocking is implemented as a reversible state transaction over the whole document.
    // Note 142: saved contains only objects whose original state must later be restored.
    // Note 143: Omitting unchanged objects reduces memory use during large batches.
    // Note 144: Layers use visible, while page items use hidden, so both states are captured.
    // Note 145: locked is captured for layers, groups, and individual page items when available.
    // Note 146: Each property read is isolated because one unsupported property should not lose others.
    // Note 147: Layers are unlocked before their page items to satisfy Illustrator mutation rules.
    // Note 148: Recursive layer traversal handles nested sublayers that may block artwork creation.
    // Note 149: Recursive group traversal handles locks hidden inside clipped or nested groups.
    // Note 150: Temporarily showing hidden objects allows consistent geometry and hierarchy traversal.
    // Note 151: Business hiding decisions are applied later after the temporary unlock phase.
    // Note 152: restoreLocks only reapplies states that were true before editing.
    // Note 153: Newly hidden duplicate masks remain hidden because they were not originally hidden entries.
    // Note 154: Originally hidden items are hidden again even if other processing did not select them.
    // Note 155: Restoration errors are ignored individually so one deleted host object does not block others.
    // Note 156: Host references can become invalid after move operations, which justifies defensive access.
    // Note 157: The active layer is restored separately because it is document UI state, not item state.
    // Note 158: A finally block around artwork mutations guarantees restoration after a JavaScript error.
    // Note 159: Native process crashes can still bypass finally, so sources are always closed without saving.
    // Note 160: This pattern resembles acquire, mutate, and release resource management in systems code.
    function unlockDocument(doc) {
        var saved = [];
        function saveState(item) {
            var entry = { item: item, wasLocked: false, wasHidden: false, wasInvisible: false };
            try { entry.wasLocked = (item.locked === true); } catch (e) {}
            try { entry.wasHidden = (item.hidden === true); } catch (e) {}
            try { entry.wasInvisible = (item.visible === false); } catch (e) {}
            if (entry.wasLocked || entry.wasHidden || entry.wasInvisible) {
                saved.push(entry);
            }
            return entry;
        }
        function visitLayers(layers) {
            for (var i = 0; i < layers.length; i++) {
                var lyr = layers[i];
                var entry = saveState(lyr);
                try {
                    lyr.locked = false;
                    lyr.visible = true;
                } catch (e) {
                    log("WARN failed to unlock layer \"" + lyr.name + "\": " + e);
                }
                visitLayers(lyr.layers);
                visitItems(lyr);
            }
        }
        function visitItems(container) {
            var items = container.pageItems;
            for (var j = 0; j < items.length; j++) {
                var it = items[j];
                var entry = saveState(it);
                try {
                    it.locked = false;
                    it.hidden = false;
                } catch (e) {
                    log("WARN failed to unlock item: " + e);
                }
                if (it.typename === "GroupItem") {
                    visitItems(it);
                }
            }
        }
        visitLayers(doc.layers);
        return saved;
    }

    function restoreLocks(saved) {
        for (var i = 0; i < saved.length; i++) {
            var entry = saved[i];
            try { if (entry.wasLocked) { entry.item.locked = true; } } catch (e) {}
            try { if (entry.wasHidden) { entry.item.hidden = true; } } catch (e) {}
            try { if (entry.wasInvisible) { entry.item.visible = false; } } catch (e) {}
        }
    }

    function getContainingLayer(item) {
        var current = item;
        while (current) {
            if (current.typename === "Layer") {
                return current;
            }
            if (current.typename === "Document") {
                break;
            }
            current = current.parent;
        }
        return null;
    }

    function getContainingLayerName(item) {
        var layer = getContainingLayer(item);
        return layer !== null ? String(layer.name) : "";
    }

    function safeLockState(item) {
        try {
            if (item.locked === true) {
                return "locked";
            }
            if (item.locked === false) {
                return "unlocked";
            }
            return "n/a";
        } catch (e) {
            return "err";
        }
    }

    function describeParentChain(item) {
        var parts = [];
        var current = item;
        while (current && current.typename !== "Document") {
            parts.push(current.typename + "[" + safeLockState(current) + "]" +
                (current.name ? "(" + current.name + ")" : ""));
            if (current.typename === "Document") {
                break;
            }
            current = current.parent;
        }
        return parts.join(" < ");
    }

    function isBackgroundLayer(item) {
        return /(background|bg)/i.test(getContainingLayerName(item));
    }

    function isSupportedBackground(item) {
        return item.typename !== "RasterItem" && item.typename !== "MeshItem";
    }

    /*
    Finds art objects and layers whose names contain "highlight" or
    "overlay" (case-insensitive) anywhere in the document and hides them, so
    highlight/overlay artwork does not appear in the adapted output. The
    whole document tree is searched recursively.
    */
    // Note 161: Name-based hiding is a separate policy from geometric duplicate detection.
    // Note 162: The regular expression is case insensitive so authoring capitalization is irrelevant.
    // Note 163: A substring match accepts names such as HIGHLIGHT copy and overlay mobile.
    // Note 164: Layers are hidden with visible=false because Layer does not use pageItem.hidden.
    // Note 165: Art objects are hidden with hidden=true because they remain in the saved document.
    // Note 166: Hiding instead of deleting preserves editable source structure in the output.
    // Note 167: The traversal covers every top-level layer and every nested sublayer.
    // Note 168: Group recursion is required because named overlay artwork can live inside a group.
    // Note 169: Try blocks protect the traversal from DOM types that reject a name or hidden access.
    // Note 170: The count records actions attempted successfully rather than objects merely inspected.
    // Note 171: Collected names make logs useful when a visual result needs later investigation.
    // Note 172: Empty names are not selected by this policy because the regex cannot match them.
    // Note 173: A layer match does not stop recursion, so named descendants are still recorded.
    // Note 174: Duplicate log entries are acceptable because layer and child hiding are distinct actions.
    // Note 175: This pass runs after the background clipping group is created.
    // Note 176: Running later prevents temporary unlocking from reversing the intended hidden state.
    // Note 177: The pass does not depend on selection, active layer, or current view state.
    // Note 178: Document-wide traversal is deterministic for a fixed Illustrator DOM hierarchy.
    // Note 179: The final summary line is informational and does not affect completion status.
    // Note 180: Policy helpers like this remain small so naming rules can evolve independently.
    function hideHighlightOverlay(doc) {
        var hiddenCount = 0;
        var names = [];

        function visitLayers(layers) {
            for (var i = 0; i < layers.length; i++) {
                var lyr = layers[i];
                try {
                    if (/(highlight|overlay)/i.test(String(lyr.name))) {
                        lyr.visible = false;
                        hiddenCount++;
                        names.push(String(lyr.name));
                    }
                } catch (e) {}
                visitLayers(lyr.layers);
                visitItems(lyr);
            }
        }

        function visitItems(container) {
            var items = container.pageItems;
            for (var j = 0; j < items.length; j++) {
                var it = items[j];
                try {
                    if (/(highlight|overlay)/i.test(String(it.name))) {
                        it.hidden = true;
                        hiddenCount++;
                        names.push(String(it.name));
                    }
                } catch (e) {}
                if (it.typename === "GroupItem") {
                    visitItems(it);
                }
            }
        }

        visitLayers(doc.layers);
        log("Info: hidden " + hiddenCount + " highlight/overlay item(s): " + names.join(", "));
    }

    /*
    Hides every art object whose shape exactly matches the detected
    background: same geometry point-for-point after position normalization,
    no rotation, and geometric bounds within sameShapePositionTolerance pt of
    the background's bounds in both directions. Runs before the background is
    enlarged so the comparison uses the original geometry. Clipping paths are
    plain paths in the DOM, so they are compared and hidden like any other
    path (hiding a clip path does not disable its mask).
    */
    // Note 181: Shape matching combines topology, control-point geometry, and approximate position.
    // Note 182: The reference signature is captured before resizing so it represents original artwork.
    // Note 183: geometricBounds are used because they exclude stroke width from the core path shape.
    // Note 184: A null signature means the item is not a supported path-based geometry type.
    // Note 185: Returning on unsupported geometry avoids guessing from width and height alone.
    // Note 186: PathItem and CompoundPathItem are handled because both can describe vector outlines.
    // Note 187: The candidate must be a different object reference from the chosen background.
    // Note 188: Translation-invariant signatures compare shape without embedding absolute coordinates.
    // Note 189: Position is checked separately with a two-point tolerance configured near the top.
    // Note 190: Comparing left and top is sufficient after an exact normalized shape match fixes size.
    // Note 191: A rotated path normally changes normalized anchors and therefore fails exact matching.
    // Note 192: Hidden duplicates are retained in the document for nondestructive editing.
    // Note 193: Each candidate comparison is isolated so one corrupt path cannot stop the file.
    // Note 194: Group recursion finds path objects nested below clipping and organization groups.
    // Note 195: Layer recursion ensures matching objects in sublayers are not missed.
    // Note 196: Illustrator collections may expose flattened descendants, so later group code tracks visits.
    // Note 197: Logging unnamed candidates by type makes the result understandable without a layer panel.
    // Note 198: Exact geometry is stricter than visual bounds and avoids hiding unrelated rectangles.
    // Note 199: The tolerance applies to placement only; it does not relax path point equality.
    // Note 200: This function performs no resize or move, keeping comparison and mutation stages separate.
    function hideSameShapeItems(doc, background) {
        var tolerance = sameShapePositionTolerance;
        var bgBounds = null;
        try {
            bgBounds = background.geometricBounds;
        } catch (e) {
            bgBounds = null;
        }
        var bgSignature = buildShapeSignature(background);
        if (bgSignature === null || bgBounds === null) {
            log("Info: hidden 0 same-shape item(s) (background has no comparable path geometry)");
            return;
        }

        var hiddenCount = 0;
        var names = [];

        function visitItems(container) {
            var items = container.pageItems;
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it !== background &&
                    (it.typename === "PathItem" || it.typename === "CompoundPathItem")) {
                    try {
                        var candSignature = buildShapeSignature(it);
                        if (candSignature !== null && shapesMatch(candSignature, bgSignature)) {
                            var candBounds = it.geometricBounds;
                            if (Math.abs(candBounds[0] - bgBounds[0]) <= tolerance &&
                                Math.abs(candBounds[1] - bgBounds[1]) <= tolerance) {
                                it.hidden = true;
                                hiddenCount++;
                                var nm = String(it.name);
                                names.push(nm !== "" ? nm : "(unnamed " + it.typename + ")");
                            }
                        }
                    } catch (e) {
                        log("WARN failed to compare/hide same-shape item: " + e);
                    }
                }
                if (it.typename === "GroupItem") {
                    visitItems(it);
                }
            }
        }

        function visitLayers(layers) {
            for (var i = 0; i < layers.length; i++) {
                var lyr = layers[i];
                visitItems(lyr);
                visitLayers(lyr.layers);
            }
        }

        visitLayers(doc.layers);
        log("Info: hidden " + hiddenCount + " same-shape item(s): " + names.join(", "));
    }

    /*
    A clipped GroupItem uses a PathItem (or a path inside a CompoundPathItem)
    with clipping=true as its mask. For a named background GroupItem, that
    mask is the only reliable path geometry representing the group's original
    background shape.
    */
    // Note 201: A clipping flag alone does not prove that a path is an active clipping mask.
    // Note 202: Active masks also require a parent GroupItem whose clipped property is true.
    // Note 203: The mask must be the top-most direct item because Illustrator uses stacking order.
    // Note 204: CompoundPathItem has no single clipping property, so its child paths are inspected.
    // Note 205: hasClippingMaskFlag answers only the low-level flag question.
    // Note 206: isActualClippingMaskItem combines flag, parent, clipped state, and stacking position.
    // Note 207: Splitting these questions makes DOM assumptions visible and easier to test.
    // Note 208: isTopmostDirectItem ignores flattened descendants by checking each item parent.
    // Note 209: The first direct child in pageItems is the top-most sibling in Illustrator.
    // Note 210: A stale clipping=true path in an unclipped group is correctly rejected.
    // Note 211: findGroupClippingMask never borrows a mask from a nested child group.
    // Note 212: A nested mask clips that nested group, not the outer background group.
    // Note 213: Requiring group.clipped prevents an ordinary unnamed group from being misclassified.
    // Note 214: The returned mask supplies geometry while the outer group remains the resize target.
    // Note 215: This models the observed export structure where the direct mask carries the Bg name.
    // Note 216: Property access remains defensive because plugin-created objects can expose partial DOM data.
    // Note 217: null communicates that no safe group mask could be identified.
    // Note 218: Validation can then explain the missing mask instead of silently choosing another path.
    // Note 219: The same predicate is reused for reference and candidate masks to keep rules symmetric.
    // Note 220: Symmetric classification prevents comparing a real mask with an inactive clipping flag.
    function hasClippingMaskFlag(item) {
        try {
            if (item.typename === "PathItem") {
                return item.clipping === true;
            }
            if (item.typename === "CompoundPathItem") {
                for (var i = 0; i < item.pathItems.length; i++) {
                    if (item.pathItems[i].clipping === true) {
                        return true;
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    function isTopmostDirectItem(item, group) {
        var items = group.pageItems;
        for (var i = 0; i < items.length; i++) {
            try {
                if (items[i].parent === group) {
                    return items[i] === item;
                }
            } catch (e) {}
        }
        return false;
    }

    function isActualClippingMaskItem(item) {
        if (!hasClippingMaskFlag(item)) {
            return false;
        }
        try {
            var parent = item.parent;
            return parent !== null &&
                parent.typename === "GroupItem" &&
                parent.clipped === true &&
                isTopmostDirectItem(item, parent);
        } catch (e) {
            return false;
        }
    }

    function findGroupClippingMask(group) {
        try {
            if (group.clipped !== true) {
                return null;
            }
        } catch (e) {
            return null;
        }

        // Only the outer background group's own direct mask is a valid
        // reference. A mask inside a nested group represents that nested group,
        // not the named background group.
        var items = group.pageItems;
        for (var i = 0; i < items.length; i++) {
            var directItem = items[i];
            try {
                if (directItem.parent === group && isActualClippingMaskItem(directItem)) {
                    return directItem;
                }
            } catch (e) {}
        }
        return null;
    }

    /*
    Group-background branch: use the background group's own clipping mask as
    the reference, then hide only other clipping masks with identical geometry
    and a position within the configured tolerance. The reference mask and all
    descendants of the background group are excluded.
    */
    function hideSameShapeClippingMasks(doc, backgroundGroup) {
        var referenceMask = findGroupClippingMask(backgroundGroup);
        if (referenceMask === null) {
            log("Info: hidden 0 same-shape clipping mask(s) " +
                "(background group has no comparable clipping mask)");
            return;
        }

        var referenceBounds = null;
        try {
            referenceBounds = referenceMask.geometricBounds;
        } catch (e) {}
        var referenceSignature = buildShapeSignature(referenceMask);
        if (referenceSignature === null || referenceBounds === null) {
            log("Info: hidden 0 same-shape clipping mask(s) " +
                "(background group clipping mask has no comparable path geometry)");
            return;
        }

        var tolerance = sameShapePositionTolerance;
        var hiddenCount = 0;
        var names = [];
        var visited = [];

        function wasVisited(item) {
            for (var i = 0; i < visited.length; i++) {
                if (visited[i] === item) {
                    return true;
                }
            }
            visited.push(item);
            return false;
        }

        function visitItems(container) {
            var items = container.pageItems;
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (!wasVisited(item) &&
                    !isDescendantOf(item, backgroundGroup) &&
                    isActualClippingMaskItem(item)) {
                    try {
                        var candidateSignature = buildShapeSignature(item);
                        if (candidateSignature !== null &&
                            shapesMatch(candidateSignature, referenceSignature)) {
                            var candidateBounds = item.geometricBounds;
                            if (Math.abs(candidateBounds[0] - referenceBounds[0]) <= tolerance &&
                                Math.abs(candidateBounds[1] - referenceBounds[1]) <= tolerance) {
                                item.hidden = true;
                                hiddenCount++;
                                var name = String(item.name);
                                names.push(name !== "" ? name : "(unnamed " + item.typename + ")");
                            }
                        }
                    } catch (e) {
                        log("WARN failed to compare/hide same-shape clipping mask: " + e);
                    }
                }
                if (item.typename === "GroupItem") {
                    visitItems(item);
                }
            }
        }

        function visitLayers(layers) {
            for (var i = 0; i < layers.length; i++) {
                var layer = layers[i];
                visitItems(layer);
                visitLayers(layer.layers);
            }
        }

        visitLayers(doc.layers);
        log("Info: hidden " + hiddenCount + " same-shape clipping mask(s): " + names.join(", "));
    }

    /*
    Builds a translation-invariant geometry signature for a PathItem or
    CompoundPathItem: for every sub-path, the sequence of anchors and control
    handles normalized to the first anchor, plus closed/evenodd flags.
    Returns null for non-path-based items (RasterItem, GroupItem, ...).
    */
    // Note 221: A shape signature converts Illustrator path geometry into plain comparable data.
    // Note 222: Plain arrays and strings are safer to retain than live host PathPoint references.
    // Note 223: The first anchor becomes an origin so translation does not change the signature.
    // Note 224: Every anchor is stored relative to that origin.
    // Note 225: Left and right Bezier handles are also stored because they determine curve shape.
    // Note 226: Omitting handles would make different curves with the same anchors look identical.
    // Note 227: closed distinguishes a closed region from an open stroke with the same points.
    // Note 228: evenodd distinguishes alternative fill rules for compound geometry.
    // Note 229: Compound paths append one signature entry for each component path.
    // Note 230: Component order remains significant, favoring copied geometry over visual heuristics.
    // Note 231: r3 rounds coordinates to three decimals to absorb insignificant host precision noise.
    // Note 232: Rounding is applied after translation so absolute canvas coordinates do not matter.
    // Note 233: The semicolon-separated point string keeps one point comparison inexpensive.
    // Note 234: shapesMatch rejects null before reading arrays, which keeps callers simple.
    // Note 235: It first rejects different subpath counts as a fast structural check.
    // Note 236: It then checks flags and point counts before comparing every encoded point.
    // Note 237: Early returns avoid unnecessary work in documents containing many unrelated paths.
    // Note 238: Exact point order means a reauthored equivalent path may not match, by design.
    // Note 239: This conservative false-negative bias is safer than hiding the wrong artwork.
    // Note 240: Geometry comparison is deterministic and does not depend on zoom or raster rendering.
    function buildShapeSignature(item) {
        var subPaths = [];
        var closedFlags = [];
        var evenOddFlags = [];
        var ref = null;

        function addSubPath(p) {
            var pts = p.pathPoints;
            var sig = [];
            for (var i = 0; i < pts.length; i++) {
                var a = pts[i].anchor;
                var l = pts[i].leftDirection;
                var r = pts[i].rightDirection;
                if (ref === null) {
                    ref = [a[0], a[1]];
                }
                sig.push(
                    r3(a[0] - ref[0]) + "," + r3(a[1] - ref[1]) + ";" +
                    r3(l[0] - ref[0]) + "," + r3(l[1] - ref[1]) + ";" +
                    r3(r[0] - ref[0]) + "," + r3(r[1] - ref[1])
                );
            }
            subPaths.push(sig);
            closedFlags.push(p.closed === true);
            evenOddFlags.push(p.evenodd === true);
        }

        if (item.typename === "PathItem") {
            addSubPath(item);
        } else if (item.typename === "CompoundPathItem") {
            var subs = item.pathItems;
            for (var i = 0; i < subs.length; i++) {
                addSubPath(subs[i]);
            }
        } else {
            return null;
        }
        return { subs: subPaths, closed: closedFlags, evenodd: evenOddFlags };
    }

    function shapesMatch(a, b) {
        if (a === null || b === null) {
            return false;
        }
        if (a.subs.length !== b.subs.length) {
            return false;
        }
        for (var i = 0; i < a.subs.length; i++) {
            if (a.closed[i] !== b.closed[i]) {
                return false;
            }
            if (a.evenodd[i] !== b.evenodd[i]) {
                return false;
            }
            if (a.subs[i].length !== b.subs[i].length) {
                return false;
            }
            for (var j = 0; j < a.subs[i].length; j++) {
                if (a.subs[i][j] !== b.subs[i][j]) {
                    return false;
                }
            }
        }
        return true;
    }

    function r3(n) {
        return Math.round(n * 1000) / 1000;
    }

    /*
    Enlarges the detected background object itself to 1000% x 1000% from its
    center. The object is reused as-is (gradients, patterns, transparency,
    effects included); nothing is rebuilt, sampled, or rasterized. Line
    widths are scaled with the artwork (uniform 10x enlargement).
    */
    // Note 241: Illustrator resize percentages use 100 as unchanged size, so 1000 means ten times larger.
    // Note 242: Equal horizontal and vertical percentages preserve the original aspect ratio.
    // Note 243: Transformation.CENTER keeps enlargement centered on the existing artwork.
    // Note 244: The Boolean arguments request transformation of geometry and relevant appearance data.
    // Note 245: Resizing the original object preserves gradients, patterns, effects, and transparency.
    // Note 246: Rebuilding a rectangle would lose that authored appearance and is intentionally avoided.
    // Note 247: A GroupItem can be resized as one unit while retaining its internal clipping structure.
    // Note 248: The group mask supplies comparison geometry but the whole group is the resize target.
    // Note 249: Resizing occurs only after same-shape masks are compared against original coordinates.
    // Note 250: Artboard clipping occurs after resizing because the enlarged art may extend far outside.
    // Note 251: artboardRect is ordered left, top, right, bottom rather than x, y, width, height.
    // Note 252: Width and height are derived explicitly to avoid coordinate-system assumptions.
    // Note 253: Illustrator vertical coordinates make height equal top minus bottom in this rectangle API.
    // Note 254: The original parent is captured before moving the background into a new group.
    // Note 255: The sibling below the background acts as an anchor for restoring its stacking slot.
    // Note 256: Descendants are skipped when searching because layer pageItems may be flattened.
    // Note 257: PLACEATEND puts the enlarged background at the bottom inside the new clipping group.
    // Note 258: PLACEATBEGINNING moves the clipping path above the artwork where Illustrator expects it.
    // Note 259: Both clipPath.clipping and clipGroup.clipped are required to activate clipping behavior.
    // Note 260: Repositioning the completed group preserves unrelated artwork order in the parent.
    function resizeBackground(background) {
        background.resize(1000, 1000, true, true, true, true, true, Transformation.CENTER);
    }

    /*
    Wraps the enlarged background in a clipping group whose clipping path
    exactly matches the target artboard. The clipping path is the top-most
    object inside the clipping group (Illustrator uses the top-most path of
    a clipped group as the clipping mask); the enlarged background sits
    underneath it. The group is created in the background's original
    container and moved back into the background's original stacking slot,
    so unrelated artwork is not reordered.
    */
    function createArtboardClipGroup(doc, background, artboard) {
        var rect = artboard.artboardRect; // [left, top, right, bottom]
        var left = rect[0];
        var top = rect[1];
        var right = rect[2];
        var bottom = rect[3];
        var width = right - left;
        var height = top - bottom;

        var parent = background.parent;

        // Remember the stacking slot of the background inside its container.
        // pageItems are ordered top (index 0) to bottom (last index), so the
        // item directly below the background is items[pos + 1].
        var items = parent.pageItems;
        var pos = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i] === background) {
                pos = i;
                break;
            }
        }
        var belowAnchor = null;
        if (pos >= 0) {
            // Skip any items nested inside the background group itself so the
            // anchor is the next true sibling below the background.
            for (var j = pos + 1; j < items.length; j++) {
                if (!isDescendantOf(items[j], background)) {
                    belowAnchor = items[j];
                    break;
                }
            }
        }

        var clipGroup;
        try {
            clipGroup = parent.groupItems.add();
            clipGroup.name = "Background Clip";
        } catch (e) {
            throw new Error("create clip group in parent: " + e);
        }

        // Enlarged background first, at the very bottom of the group.
        try {
            background.move(clipGroup, ElementPlacement.PLACEATEND);
        } catch (e) {
            throw new Error("move background into clip group: " + e);
        }

        // Artboard-sized clipping path with no visible stroke or fill.
        var clipPath;
        try {
            clipPath = clipGroup.pathItems.rectangle(top, left, width, height);
        } catch (e) {
            throw new Error("create clip path (rectangle): " + e);
        }
        try {
            clipPath.filled = false;
            clipPath.stroked = false;
        } catch (e) {
            throw new Error("create clip path (style): " + e);
        }
        try {
            // The clipping path must be above the background inside the group.
            clipPath.move(clipGroup, ElementPlacement.PLACEATBEGINNING);
        } catch (e) {
            throw new Error("create clip path (move): " + e);
        }

        try {
            clipPath.clipping = true;
            clipGroup.clipped = true;
        } catch (e) {
            throw new Error("enable clipping: " + e);
        }

        // Put the clipping group back into the background's old stacking slot.
        try {
            if (belowAnchor !== null) {
                clipGroup.move(belowAnchor, ElementPlacement.PLACEBEFORE);
            } else {
                clipGroup.move(parent, ElementPlacement.PLACEATEND);
            }
        } catch (e) {
            throw new Error("reposition clip group: " + e);
        }

        return clipGroup;
    }

    /*
    True when descendant is the background itself or lives inside it.
    */
    function isDescendantOf(descendant, background) {
        var current = descendant;
        while (current) {
            if (current === background) {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    function saveAsOutput(doc, outputFile) {
        // Default Illustrator save options: normal compatibility, PDF
        // compatibility, and compression behavior of a plain Save As.
        var options = new IllustratorSaveOptions();
        doc.saveAs(outputFile, options);
    }

    function makeSkip(message) {
        return { status: "SKIPPED", message: message };
    }

    // Note 261: processOneFile is organized as a transaction with validation, mutation, save, and cleanup.
    // Note 262: fileProcessed increments before validation so missing and invalid entries are counted.
    // Note 263: doc starts as null, which makes the finally cleanup conditional and idempotent.
    // Note 264: saved distinguishes a complete saveAs call from a partially created output file.
    // Note 265: Resume validation happens before app.open to avoid unnecessary native document work.
    // Note 266: app.open is a native boundary that can crash Illustrator outside JavaScript exception handling.
    // Note 267: Stage markers are written immediately before and after every high-risk native operation.
    // Note 268: Bottom-object detection and name validation occur before any document mutation.
    // Note 269: Group backgrounds may inherit their accepted name from their own direct clipping mask.
    // Note 270: Unsupported raster and mesh backgrounds are skipped rather than converted or rebuilt.
    // Note 271: Temporary unlock state is enclosed in finally so JavaScript errors restore author state.
    // Note 272: Each mutation stage wraps errors with context that appears in the batch log.
    // Note 273: A unique output name is allocated only after artwork adaptation succeeds.
    // Note 274: saveAs writes a new document path while the original source remains open in memory.
    // Note 275: Closing with DONOTSAVECHANGES prevents the source path from receiving modifications.
    // Note 276: The completion record is appended only after saveAs and clean close both return.
    // Note 277: If saveAs fails partway, an incomplete output is removed when it is safe to do so.
    // Note 278: If saveAs succeeded but close failed, the output is retained but not marked complete.
    // Note 279: The outer finally attempts cleanup-close for every path that still owns a document.
    // Note 280: Per-file isolation lets ordinary errors continue while preserving detailed failure evidence.
    function processOneFile(path, sequence, total, usedNames, completedRecords) {
        fileProcessed++;
        var sourceFile = new File(path);
        var doc = null;
        var outputFile = null;
        var saved = false;

        log("");
        log("[" + sequence + "/" + total + "] " + path);
        log("BEGIN [" + sequence + "/" + total + "] source=" + path);

        try {
            if (!sourceFile.exists) {
                throw makeSkip("Source file does not exist");
            }
            if (!isAiFilePath(path)) {
                throw makeSkip("Not an .ai file");
            }

            var sourceCompletionKey = completionKey(sourceFile);
            if (completedRecords[sourceCompletionKey] !== undefined) {
                fileDone++;
                fileResumed++;
                log("Status: ALREADY DONE (verified completion record)");
                log("Output: " + completedRecords[sourceCompletionKey]);
                log("DONE [" + sequence + "/" + total + "] source=" + path +
                    " output=" + completedRecords[sourceCompletionKey] + " resumed=true");
                return;
            }

            // Open-document entries consume the per-session budget; resumed
            // entries above never touch documents, so they stay free.
            sessionProcessed++;

            logStage(sequence, total, path, "open", "begin");
            flushLog();
            doc = app.open(sourceFile);
            logStage(sequence, total, path, "open", "done");

            logStage(sequence, total, path, "detect-background", "begin");
            var background = findBottomMostVisibleItem(doc);
            logStage(sequence, total, path, "detect-background", "done");
            if (background === null) {
                throw makeSkip("No bottom-most visible artwork found");
            }

            logStage(sequence, total, path, "validate-background", "begin");
            if (!isBackgroundItem(background)) {
                var groupMask = null;
                if (background.typename === "GroupItem") {
                    groupMask = findGroupClippingMask(background);
                }

                if (trimText(background.name) === "" &&
                        groupMask !== null && isBackgroundItem(groupMask)) {
                    log("Note: unnamed GroupItem accepted because its own clipping mask " +
                        "name matched (mask: \"" + groupMask.name + "\").");
                } else if (allowLayerNameMatch && isBackgroundLayer(background)) {
                    log("Note: object name did not match but containing layer name matched (allowLayerNameMatch).");
                } else {
                    var groupMaskDetail = "";
                    if (background.typename === "GroupItem") {
                        groupMaskDetail = groupMask === null ?
                            ", own clipping mask: not found" :
                            ", own clipping mask name: \"" + groupMask.name + "\"";
                    }
                    throw makeSkip(
                        "Bottom-most visible object name does not contain \"background\" or \"bg\" " +
                        "(name: \"" + background.name + "\", type: " + background.typename +
                        ", layer: \"" + getContainingLayerName(background) + "\"" +
                        groupMaskDetail + ")"
                    );
                }
            }
            if (!isSupportedBackground(background)) {
                throw makeSkip("Background object is " + background.typename + " (unsupported)");
            }
            logStage(sequence, total, path, "validate-background", "done");

            // Target artboard: the active artboard of the opened document.
            logStage(sequence, total, path, "read-artboard", "begin");
            var artboard = doc.artboards[doc.artboards.getActiveArtboardIndex()];
            logStage(sequence, total, path, "read-artboard", "done");

            // Diagnostic line so the log always records what was detected.
            logStage(sequence, total, path, "describe-background", "begin");
            log("Info: background " + background.typename + " name=\"" + background.name +
                "\" layer=\"" + getContainingLayerName(background) + "\"");
            logStage(sequence, total, path, "describe-background", "done");

            // Locked/hidden layers block creation of new artwork ("Target layer
            // cannot be modified"), so make the whole document visible and
            // unlocked temporarily, adapt, and restore every state before saving.
            logStage(sequence, total, path, "unlock", "begin");
            var unlocked = unlockDocument(doc);
            logStage(sequence, total, path, "unlock", "done");
            var previousActiveLayer = null;
            try { previousActiveLayer = doc.activeLayer; } catch (e) {}
            var bgLayer = getContainingLayer(background);
            try { doc.activeLayer = bgLayer; } catch (e) {}
            log("Info: parent chain (after unlock): " + describeParentChain(background));
            try {
                try {
                    if (background.typename === "GroupItem") {
                        logStage(sequence, total, path, "same-shape-clipping-masks", "begin");
                        hideSameShapeClippingMasks(doc, background);
                        logStage(sequence, total, path, "same-shape-clipping-masks", "done");
                    } else {
                        logStage(sequence, total, path, "same-shape", "begin");
                        hideSameShapeItems(doc, background);
                        logStage(sequence, total, path, "same-shape", "done");
                    }
                } catch (shapeErr) {
                    throw new Error("hide same-shape failed: " + shapeErr);
                }
                try {
                    logStage(sequence, total, path, "resize", "begin");
                    resizeBackground(background);
                    logStage(sequence, total, path, "resize", "done");
                } catch (resizeErr) {
                    throw new Error("resize failed: " + resizeErr);
                }
                try {
                    logStage(sequence, total, path, "clip", "begin");
                    createArtboardClipGroup(doc, background, artboard);
                    logStage(sequence, total, path, "clip", "done");
                } catch (clipErr) {
                    throw new Error("clip-group creation failed: " + clipErr);
                }
                try {
                    logStage(sequence, total, path, "hide-highlight-overlay", "begin");
                    hideHighlightOverlay(doc);
                    logStage(sequence, total, path, "hide-highlight-overlay", "done");
                } catch (hideErr) {
                    throw new Error("hide highlight/overlay failed: " + hideErr);
                }
            } finally {
                logStage(sequence, total, path, "restore", "begin");
                try { doc.activeLayer = previousActiveLayer; } catch (e) {}
                restoreLocks(unlocked);
                logStage(sequence, total, path, "restore", "done");
            }

            // Only a validated, adapted document consumes an output name.
            // Existing files are never overwritten, including files left by a
            // crash that happened before the durable completion record.
            outputFile = getUniqueAiFile(outputFolder, pathBaseName(path), usedNames);
            logStage(sequence, total, path, "saveAs", "begin");
            flushLog();
            saveAsOutput(doc, outputFile);
            saved = true;
            logStage(sequence, total, path, "saveAs", "done");
            settleAfterNativeOperation(sequence, total, path, "settle-after-save");

            logStage(sequence, total, path, "close", "begin");
            flushLog();
            doc.close(SaveOptions.DONOTSAVECHANGES);
            doc = null;
            logStage(sequence, total, path, "close", "done");
            settleAfterNativeOperation(sequence, total, path, "settle-after-close");

            appendCompletionRecord(completionFile, sourceFile, outputFile);
            completedRecords[sourceCompletionKey] = normalizedFsName(outputFile);
            fileDone++;
            log("Status: DONE");
            log("Output: " + normalizedFsName(outputFile));
            log("DONE [" + sequence + "/" + total + "] source=" + path +
                " output=" + normalizedFsName(outputFile) + " resumed=false");
        } catch (e) {
            fileSkipped++;
            var status = (e && e.status) ? e.status : "FAILED";
            var reason = (e && e.message) ? e.message : String(e);
            log("Status: " + status);
            log("Reason: " + reason);
            log("END [" + sequence + "/" + total + "] source=" + path +
                " status=" + status + " reason=" + reason);
            if (saved && outputFile !== null && outputFile.exists) {
                log("Note: output file was written but the document was not closed cleanly: " +
                    normalizedFsName(outputFile));
            } else if (outputFile !== null && outputFile.exists) {
                // saveAs() failed partway: remove the partial/incomplete output.
                try {
                    outputFile.remove();
                } catch (ignore) {}
            }
        } finally {
            if (doc !== null) {
                try {
                    logStage(sequence, total, path, "cleanup-close", "begin");
                    flushLog();
                    doc.close(SaveOptions.DONOTSAVECHANGES);
                    doc = null;
                    logStage(sequence, total, path, "cleanup-close", "done");
                    settleAfterNativeOperation(sequence, total, path, "settle-after-cleanup-close");
                } catch (closeError) {
                    log("ERROR close failed: " + path + "; " + closeError);
                }
            }
        }
    }

    // Note 281: The summary reports aggregate state even when startup or the main loop throws.
    // Note 282: A fallback startTime keeps duration formatting valid after unusually early failures.
    // Note 283: Counters separate completed outputs, resumed outputs, and skipped attempts.
    // Note 284: The expected invariant is processed equals skipped plus done for a full list pass.
    // Note 285: Resumed is a subset of done because a verified output is still a successful result.
    // Note 286: main owns batch-level setup while processOneFile owns document-level cleanup.
    // Note 287: The output directory is created before the list is processed because every success needs it.
    // Note 288: Requested completion keys are built once to scope all resume filesystem checks.
    // Note 289: Legacy logs are scanned only while the current list still has unresolved records.
    // Note 290: Requested-key filtering prevents unrelated historical paths from triggering existence checks.
    // Note 291: usedNames is shared across the loop so collisions are prevented within this session.
    // Note 292: The loop index supplies stable sequence numbers without changing source order.
    // Note 293: processOneFile catches expected per-file failures, while the loop catch is a final guard.
    // Note 294: The loop guard logs an unexpected exception and then advances to the next entry.
    // Note 295: app.userInteractionLevel is changed immediately before main starts host work.
    // Note 296: The outer catch records batch failures that occur outside normal per-file handling.
    // Note 297: The outer finally restores Illustrator interaction settings before writing the summary.
    // Note 298: Summary logging occurs before closeLog so the final counters reach durable storage.
    // Note 299: No image export API appears in this workflow; output artifacts remain Illustrator files.
    // Note 300: The closing IIFE call executes the workflow once when Illustrator evaluates the JSX file.
    function writeSummary() {
        if (startTime === null) {
            startTime = new Date();
        }
        var endTime = new Date();
        log("");
        log("=====================================");
        log("Summary");
        log("");
        log("Start Time: " + nowText(startTime));
        log("End Time: " + nowText(endTime));
        log("Duration: " + formatDuration(endTime.getTime() - startTime.getTime()));
        log("");
        log("File Count: " + fileCount);
        log("File Processed: " + fileProcessed);
        log("File Skipped: " + fileSkipped);
        log("File Done: " + fileDone);
        log("File Resumed: " + fileResumed);
    }

    function main() {
        startTime = new Date();
        openLog();
        var marker = readRestartMarker();
        if (marker !== null) {
            log("Restart Marker: " + marker);
        }

        log("Illustrator Background Adaptation Log");
        log("=====================================");
        log("");
        log("Start Time: " + nowText(startTime));
        log("Input List: " + listFile.fsName);
        log("Output Folder: " + outputFolder.fsName);
        log("Completion Records: " + completionFile.fsName);
        log("");

        // Without the output folder no output file can be written, so abort
        // the whole batch with a clear log entry instead of failing per-file.
        try {
            ensureFolder(outputFolder);
        } catch (e) {
            log("ERROR cannot create output folder: " + outputFolder.fsName + "; " + e);
            return;
        }

        var files = readFileList(listFile);
        fileCount = files.length;
        log("Total Files: " + fileCount);
        log("");

        var usedNames = {};
        var requestedCompletionKeys = buildRequestedCompletionKeys(files);
        var completedRecords = readCompletionRecords(completionFile, requestedCompletionKeys);

        // Only unresolved files from this run need the legacy migration path.
        // The importer still filters before touching source or output paths, so
        // unrelated historical network records never trigger existence checks.
        if (hasMissingRequestedCompletion(requestedCompletionKeys, completedRecords)) {
            importLegacyCompletionRecords(
                outputFolder,
                completedRecords,
                completionFile,
                requestedCompletionKeys
            );
        } else {
            log("Resume: all current files resolved from persistent completion records; " +
                "legacy log import skipped.");
        }
        for (var i = 0; i < files.length; i++) {
            if (maxFilesPerSession > 0 && sessionProcessed >= maxFilesPerSession) {
                // Session budget reached: entries already covered by
                // completion records may be finished cheaply (they never open
                // a document); anything else belongs to the next session.
                var remainingUnfinished = false;
                for (var j = i; j < files.length; j++) {
                    if (completedRecords[completionKey(new File(files[j]))] === undefined) {
                        remainingUnfinished = true;
                        break;
                    }
                }
                if (remainingUnfinished) {
                    log("Session limit reached (" + sessionProcessed +
                        " documents opened >= " + maxFilesPerSession +
                        "); continuing after Illustrator restart.");
                    break;
                }
            }
            // Already-completed entries are fast-forwarded silently: they
            // never open a document, never produce a new complete record, and
            // writing four log lines per entry floods the tail of the log with
            // "resumed" lines while nothing visibly progresses. Counting them
            // keeps File Resumed exact; processing only unresolved entries
            // keeps the tail of the log focused on actual work.
            if (completedRecords[completionKey(new File(files[i]))] !== undefined) {
                fileProcessed++;
                fileDone++;
                fileResumed++;
                fastForwarded++;
                continue;
            }
            try {
                processOneFile(files[i], i + 1, files.length, usedNames, completedRecords);
            } catch (e) {
                // processOneFile isolates per-file errors; this is a
                // last-resort guard so one file can never stop the batch.
                fileSkipped++;
                log("[" + (i + 1) + "/" + files.length + "] " + files[i]);
                log("Status: FAILED");
                log("Reason: unexpected per-file exception: " + e);
            }
            // Reclaim ExtendScript wrapper objects after each file. Native
            // Illustrator memory is bounded by the per-session restart, but
            // this keeps the JS heap from also growing without bound.
            if (typeof $.gc === "function") {
                try { $.gc(); } catch (gcError) {}
            }
        }
        if (fastForwarded > 0) {
            log("Fast-forwarded " + fastForwarded +
                " already-completed entries (no new outputs).");
        }
        // Restart protocol: persist the batch state before quitting. The
        // launcher reads the marker and starts Illustrator again only for
        // CONTINUE; DONE means every listed file has a verified output.
        if (i < files.length && maxFilesPerSession > 0 &&
                sessionProcessed >= maxFilesPerSession) {
            writeRestartMarker("CONTINUE");
            shouldQuit = true;
            log("Restart marker set to CONTINUE; Illustrator will quit " +
                "for the next session.");
        } else {
            writeRestartMarker("DONE");
            log("Restart marker set to DONE; batch complete.");
        }
        // The summary is written in the outer finally block so it is always
        // produced, even if an unexpected error interrupts the loop.
    }

    try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        main();
    } catch (e) {
        log("ERROR batch exception: " + e);
    } finally {
        try {
            app.userInteractionLevel = oldInteractionLevel;
        } catch (restoreError) {
            log("ERROR failed to restore userInteractionLevel: " + restoreError);
        }
        writeSummary();
        closeLog();
        if (shouldQuit) {
            app.quit();
        }
    }
})();
