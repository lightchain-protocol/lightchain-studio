"use strict";
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="5bb53372-ea9a-5c52-a924-2fdee8a884ad")}catch(e){}}();


// ../server/src/frameworks/Truffle/ConfigLoader.ts
var import_process = require("process");
var config = require(import_process.argv[2]);
process.send(config);

//# debugId=5bb53372-ea9a-5c52-a924-2fdee8a884ad
