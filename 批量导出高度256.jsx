/*
Batch export AI artboards to PNG files with output height 256 px.

This JSX reads "file list.txt" in Chinese file name from the same folder as
this script, opens each listed .ai file, outlines all text, exports every
artboard, writes a log, and closes the document without saving changes.

Important note:
Illustrator ExtendScript cannot reliably detect only "missing font" text
objects across versions. To avoid substituted fonts affecting output, this
script conservatively tries to outline all text objects after opening each
document. The source AI file is not saved.
*/

(function () {
    var oldInteractionLevel = app.userInteractionLevel;
    var scriptFile = new File($.fileName);
    var scriptFolder = scriptFile.parent;

    var listFileName = "\u6587\u4EF6\u5217\u8868.txt";
    var outputFolderName = "\u9AD8\u5EA6 256";
    var logFileName = "\u6279\u91CF\u5BFC\u51FA\u65E5\u5FD7.txt";
    var artboardKeyword = "\u753B\u677F";

    var listFile = new File(scriptFolder.fsName + "/" + listFileName);
    var outputFolder = new Folder(scriptFolder.fsName + "/" + outputFolderName);
    var logFile = new File(scriptFolder.fsName + "/" + logFileName);
    var logLines = [];

    function nowText() {
        var d = new Date();
        function pad(n) {
            return n < 10 ? "0" + n : "" + n;
        }
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
            " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function log(message) {
        logLines.push("[" + nowText() + "] " + message);
    }

    function writeLog() {
        try {
            logFile.encoding = "UTF-8";
            logFile.open("w");
            for (var i = 0; i < logLines.length; i++) {
                logFile.writeln(logLines[i]);
            }
            logFile.close();
        } catch (e) {
            try {
                if (logFile.opened) {
                    logFile.close();
                }
            } catch (ignore) {}
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
                throw new Error("Cannot create output folder: " + folderObj.fsName);
            }
        }
    }

    function getBaseName(fileObj) {
        var name = fileObj.name;
        try {
            name = decodeURI(name);
        } catch (e) {
            name = fileObj.name;
        }
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

    function getUniquePngFile(folderObj, baseName, usedNames) {
        var safeBase = sanitizeFileName(baseName, "untitled");
        var candidate = safeBase + ".png";
        var index = 2;
        var key = candidate.toLowerCase();

        while (usedNames[key]) {
            candidate = safeBase + "_" + index + ".png";
            key = candidate.toLowerCase();
            index++;
        }

        usedNames[key] = true;
        return new File(folderObj.fsName + "/" + candidate);
    }

    function artboardHeight(artboard) {
        var rect = artboard.artboardRect;
        return Math.abs(rect[1] - rect[3]);
    }

    function artboardExportBaseName(doc, index, sourceBaseName) {
        var artboardName = "";
        try {
            artboardName = doc.artboards[index].name;
        } catch (e) {
            artboardName = "";
        }

        if (
            artboardName === "icon" ||
            artboardName.indexOf(artboardKeyword) >= 0 ||
            artboardName.indexOf("material_product_icon") >= 0
        ) {
            return sourceBaseName;
        }

        return sanitizeFileName(artboardName, sourceBaseName);
    }

    function shouldSkipArtboard(doc, index) {
        var artboardName = "";
        try {
            artboardName = doc.artboards[index].name;
        } catch (e) {
            artboardName = "";
        }

        return artboardName.indexOf("_fg") >= 0 || artboardName.indexOf("_bg") >= 0;
    }

    function outlineTextFrame(textFrame, pathForLog) {
        try {
            textFrame.createOutline();
        } catch (e) {
            log("ERROR outline failed: " + pathForLog + "; " + e);
        }
    }

    function outlineTextFramesInCollection(collection, pathForLog) {
        for (var i = collection.length - 1; i >= 0; i--) {
            try {
                outlineTextFrame(collection[i], pathForLog);
            } catch (e) {
                log("ERROR outline traversal failed: " + pathForLog + "; index " + i + "; " + e);
            }
        }
    }

    function outlineAllText(doc, sourcePath) {
        /*
        createOutline() changes the textFrames collection, so iterate backward.
        doc.textFrames includes text inside layers, groups, and nested structures
        in normal Illustrator documents. Locked, hidden, or version-specific
        failures are logged and do not stop export.
        */
        try {
            outlineTextFramesInCollection(doc.textFrames, sourcePath);
        } catch (e) {
            log("ERROR outline process failed: " + sourcePath + "; " + e);
        }
    }

    function makePngOptions(scalePercent) {
        var options = new ExportOptionsPNG24();
        options.antiAliasing = true;
        options.artBoardClipping = true;
        options.transparency = true;
        options.horizontalScale = scalePercent;
        options.verticalScale = scalePercent;

        try {
            options.matte = false;
        } catch (ignoreMatte) {}

        return options;
    }

    function exportArtboards(doc, sourceFile, sourcePath, usedNames) {
        var sourceBaseName = sanitizeFileName(getBaseName(sourceFile), "untitled");
        var count = doc.artboards.length;

        for (var i = 0; i < count; i++) {
            try {
                doc.artboards.setActiveArtboardIndex(i);

                if (shouldSkipArtboard(doc, i)) {
                    log("SKIP artboard by name rule: " + sourcePath + "; artboard " + (i + 1));
                    continue;
                }

                var height = artboardHeight(doc.artboards[i]);
                if (height <= 0) {
                    log("ERROR export failed: " + sourcePath + "; artboard " + (i + 1) + " has invalid height.");
                    continue;
                }

                var scalePercent = 256 / height * 100;
                var exportBaseName = artboardExportBaseName(doc, i, sourceBaseName);
                var outputFile = getUniquePngFile(outputFolder, exportBaseName, usedNames);
                var options = makePngOptions(scalePercent);

                doc.exportFile(outputFile, ExportType.PNG24, options);
                log("EXPORTED " + outputFile.fsName.replace(/\\/g, "/"));
            } catch (e) {
                log("ERROR export failed: " + sourcePath + "; artboard " + (i + 1) + "; " + e);
            }
        }
    }

    function processOneFile(path, usedNames) {
        var sourceFile = new File(path);
        var doc = null;

        if (!sourceFile.exists) {
            log("SKIP missing file: " + path);
            return;
        }

        log("START file: " + path);

        try {
            doc = app.open(sourceFile);
        } catch (e) {
            log("ERROR open failed: " + path + "; " + e);
            return;
        }

        try {
            outlineAllText(doc, path);
            exportArtboards(doc, sourceFile, path, usedNames);
            log("DONE file: " + path);
        } catch (e) {
            log("ERROR process failed: " + path + "; " + e);
        } finally {
            if (doc !== null) {
                try {
                    doc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeError) {
                    log("ERROR close failed: " + path + "; " + closeError);
                }
            }
        }
    }

    log("START time: " + nowText());

    try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        ensureFolder(outputFolder);

        var files = readFileList(listFile);
        log("FILE COUNT: " + files.length);

        var usedNames = {};
        for (var i = 0; i < files.length; i++) {
            try {
                processOneFile(files[i], usedNames);
            } catch (e) {
                log("ERROR per-file process exception: " + files[i] + "; " + e);
            }
        }
    } catch (e) {
        log("ERROR batch exception: " + e);
    } finally {
        try {
            app.userInteractionLevel = oldInteractionLevel;
        } catch (restoreError) {
            log("ERROR failed to restore userInteractionLevel: " + restoreError);
        }

        log("END time: " + nowText());
        writeLog();
    }
})();
