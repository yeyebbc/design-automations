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
     directions); this also catches "highlight"/"overlay" copies that share
     the background's shape
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

The background name rule inspects the bottom-most object's own name. An
optional layer-name fallback exists (see the allowLayerNameMatch setting
in the configuration block below) for files whose background artwork lives
inside a layer named "Background"/"bg" while the art objects themselves
are unnamed.

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
    // Conservative pauses around document transitions. These reduce pressure
    // on Illustrator's asynchronous renderer but cannot prevent native crashes.
    var nativeSettleDelayMs = 300;
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
    // ---------------------------------------------------------------------

    var listFile = new File(scriptFolder.fsName + "/" + listFileName);
    var outputFolder = new Folder(scriptFolder.fsName + "/" + outputFolderName);
    var completionFile = new File(outputFolder.fsName + "/" + completionFileName);

    var logPath = null;

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
    Logging with per-line durability: each line is written by opening the
    log in append mode, writing, and closing again, so every line is flushed
    to disk immediately. Even if the run is interrupted or crashes, every
    line written so far survives. The summary is written in the outermost
    finally block.
    */
    function log(message) {
        if (logPath === null) {
            return;
        }
        try {
            logPath.encoding = "UTF-8";
            if (logPath.open("a")) {
                logPath.writeln(message);
                logPath.close();
            }
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
                    f.close();        // log() reopens per line and flushes
                    logPath = f;
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
                logPath.close();
            }
        } catch (e) {}
        logPath = null;
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

    function readCompletionRecords(fileObj) {
        var completed = {};
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
                try {
                    var outputPath = decodeURIComponent(parts[2]);
                    var recordedOutput = new File(outputPath);
                    if (recordedOutput.exists) {
                        completed[parts[1]] = normalizedFsName(recordedOutput);
                    } else {
                        log("WARN stale completion record ignored; output missing: " + outputPath);
                    }
                } catch (recordError) {
                    log("WARN malformed completion record ignored: " + recordError);
                }
            }
            fileObj.close();
        } catch (e) {
            log("WARN failed to read completion records: " + e);
            try { if (fileObj.opened) { fileObj.close(); } } catch (ignore) {}
        }
        return completed;
    }

    function importLegacyCompletionRecords(folderObj, completed, recordFile) {
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
                        var outputFile = new File(line.substring(8));
                        var key = completionKey(sourceFile);
                        if (sourceFile.exists && outputFile.exists && completed[key] === undefined) {
                            completed[key] = normalizedFsName(outputFile);
                            if (appendCompletionRecord(recordFile, sourceFile, outputFile)) {
                                imported++;
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
    Builds a translation-invariant geometry signature for a PathItem or
    CompoundPathItem: for every sub-path, the sequence of anchors and control
    handles normalized to the first anchor, plus closed/evenodd flags.
    Returns null for non-path-based items (RasterItem, GroupItem, ...).
    */
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

            logStage(sequence, total, path, "open", "begin");
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
                if (allowLayerNameMatch && isBackgroundLayer(background)) {
                    log("Note: object name did not match but containing layer name matched (allowLayerNameMatch).");
                } else {
                    throw makeSkip(
                        "Bottom-most visible object name does not contain \"background\" or \"bg\" " +
                        "(name: \"" + background.name + "\", type: " + background.typename +
                        ", layer: \"" + getContainingLayerName(background) + "\")"
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
                    logStage(sequence, total, path, "same-shape", "begin");
                    hideSameShapeItems(doc, background);
                    logStage(sequence, total, path, "same-shape", "done");
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
            saveAsOutput(doc, outputFile);
            saved = true;
            logStage(sequence, total, path, "saveAs", "done");
            settleAfterNativeOperation(sequence, total, path, "settle-after-save");

            logStage(sequence, total, path, "close", "begin");
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
        var completedRecords = readCompletionRecords(completionFile);
        importLegacyCompletionRecords(outputFolder, completedRecords, completionFile);
        for (var i = 0; i < files.length; i++) {
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
    }
})();
