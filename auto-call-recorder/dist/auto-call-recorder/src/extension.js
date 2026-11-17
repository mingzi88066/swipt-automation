"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// swipt-automation-examples/auto-call-recorder/src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  default: () => extension_default
});
module.exports = __toCommonJS(extension_exports);

// swipt-automation-examples/auto-call-recorder/node_modules/@babel/runtime/helpers/esm/asyncIterator.js
function _asyncIterator(r) {
  var n, t, o, e = 2;
  for ("undefined" != typeof Symbol && (t = Symbol.asyncIterator, o = Symbol.iterator); e--; ) {
    if (t && null != (n = r[t])) return n.call(r);
    if (o && null != (n = r[o])) return new AsyncFromSyncIterator(n.call(r));
    t = "@@asyncIterator", o = "@@iterator";
  }
  throw new TypeError("Object is not async iterable");
}
function AsyncFromSyncIterator(r) {
  function AsyncFromSyncIteratorContinuation(r2) {
    if (Object(r2) !== r2) return Promise.reject(new TypeError(r2 + " is not an object."));
    var n = r2.done;
    return Promise.resolve(r2.value).then(function(r3) {
      return {
        value: r3,
        done: n
      };
    });
  }
  return AsyncFromSyncIterator = function AsyncFromSyncIterator2(r2) {
    this.s = r2, this.n = r2.next;
  }, AsyncFromSyncIterator.prototype = {
    s: null,
    n: null,
    next: function next() {
      return AsyncFromSyncIteratorContinuation(this.n.apply(this.s, arguments));
    },
    "return": function _return(r2) {
      var n = this.s["return"];
      return void 0 === n ? Promise.resolve({
        value: r2,
        done: true
      }) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments));
    },
    "throw": function _throw(r2) {
      var n = this.s["throw"];
      return void 0 === n ? Promise.reject(r2) : AsyncFromSyncIteratorContinuation(n.apply(this.s, arguments));
    }
  }, new AsyncFromSyncIterator(r);
}

// swipt-automation-examples/auto-call-recorder/src/extension.ts
var accessibility = __toESM(require("@swipt/api/accessibility"), 1);
var device = __toESM(require("@swipt/api/device"), 1);
var import_swiplet = require("@swipt/api/swiplet");
var phoneBundleIds = /* @__PURE__ */ new Set(
  [
    "com.apple.mobilephone",
    "com.apple.InCallService",
    "com.apple.CoreTelephony",
    "com.apple.CallKitService"
  ]
);
var MORE_LABEL = "\u66F4\u591A";
var RECORD_LABEL = "\u901A\u8BDD\u5F55\u97F3";
var activeCalls = /* @__PURE__ */ new Map();
async function tapElement(element, label, signal) {
  if (!element.frame) {
    console.warn(`[auto-call-recorder] ${label} \u6CA1\u6709\u4F4D\u7F6E\u4FE1\u606F`);
    return false;
  }
  await accessibility.tap(element, { signal });
  console.log(`[auto-call-recorder] \u5DF2\u70B9\u51FB ${label}`);
  return true;
}
async function findAndTap(selector, label, options) {
  console.log(`[auto-call-recorder] \u67E5\u627E ${label}...`);
  var element = await accessibility.find(selector, {
    timeoutMs: options.timeoutMs,
    poll: true,
    signal: options.signal
  });
  if (!element) {
    console.warn(`[auto-call-recorder] \u672A\u627E\u5230 ${label}`);
    return false;
  }
  return tapElement(element, label, options.signal);
}
async function recordCall(bundleId, pid, signal) {
  console.log(`[auto-call-recorder] \u68C0\u6D4B\u5230\u901A\u8BDD\u754C\u9762: ${bundleId} pid ${pid}`);
  await sleep(800);
  if (signal.aborted) return;
  var moreTapped = await findAndTap(
    { label: MORE_LABEL },
    MORE_LABEL,
    { timeoutMs: 3e3, signal }
  );
  if (!moreTapped) return;
  await sleep(600);
  if (signal.aborted) return;
  var recordTapped = await findAndTap(
    { label: RECORD_LABEL },
    RECORD_LABEL,
    { timeoutMs: 3e3, signal }
  );
  if (recordTapped) {
    console.log(`[auto-call-recorder] \u81EA\u52A8\u5F55\u97F3\u5DF2\u89E6\u53D1`);
  }
}
var extension_default = (0, import_swiplet.defineExtension)({
  async run({ signal }) {
    console.log("[auto-call-recorder] \u670D\u52A1\u5DF2\u542F\u52A8");
    var _iteratorAbruptCompletion = false;
    var _didIteratorError = false;
    var _iteratorError;
    try {
      for (var _iterator = _asyncIterator(device.applicationEvents({ signal })), _step; _iteratorAbruptCompletion = !(_step = await _iterator.next()).done; _iteratorAbruptCompletion = false) {
        var event = _step.value;
        {
          if (!phoneBundleIds.has(event.bundleId)) {
            continue;
          }
          var running = activeCalls.get(event.pid);
          if (event.type === "background") {
            if (running) {
              running.abort();
              activeCalls.delete(event.pid);
              console.log(`[auto-call-recorder] \u901A\u8BDD\u7ED3\u675F: ${event.bundleId}`);
            }
            continue;
          }
          if (running) {
            continue;
          }
          if (event.type === "foreground" || event.type === "launch") {
            var controller = new AbortController();
            activeCalls.set(event.pid, controller);
            recordCall(event.bundleId, event.pid, controller.signal).catch(
              (error) => {
                if (error.name !== "AbortError") {
                  console.error("[auto-call-recorder] \u5F55\u97F3\u5931\u8D25:", error);
                }
              }
            );
          }
        }
      }
    } catch (err) {
      _didIteratorError = true;
      _iteratorError = err;
    } finally {
      try {
        if (_iteratorAbruptCompletion && _iterator.return != null) {
          await _iterator.return();
        }
      } finally {
        if (_didIteratorError) {
          throw _iteratorError;
        }
      }
    }
  },
  actions: {
    inspect: (0, import_swiplet.defineAction)({
      title: "Inspect Current Screen",
      description: "\u6253\u5370\u5F53\u524D\u65E0\u969C\u788D\u6811\uFF0C\u7528\u4E8E\u8C03\u8BD5",
      run: async () => {
        var snapshot2 = await accessibility.snapshot({ full: true });
        var foreground = await device.foregroundApplication.get();
        return {
          app: foreground,
          tree: simplifyTree(snapshot2.root)
        };
      }
    }),
    triggerOnce: (0, import_swiplet.defineAction)({
      title: "Trigger Once",
      description: "\u7ACB\u5373\u5C1D\u8BD5\u70B9\u51FB\u5F53\u524D\u901A\u8BDD\u754C\u9762\u7684\u5F55\u97F3\u6309\u94AE",
      run: async () => {
        var controller = new AbortController();
        var timeout = setTimeout(() => controller.abort(), 8e3);
        try {
          await recordCall("manual", 0, controller.signal);
          return { ok: true };
        } finally {
          clearTimeout(timeout);
        }
      }
    })
  }
});
function simplifyTree(element, depth = 0) {
  var result = {};
  if (element.role) result.role = element.role;
  if (element.label) result.label = element.label;
  if (element.value) result.value = element.value;
  if (element.frame) result.frame = element.frame;
  if (element.traits?.length) result.traits = element.traits;
  if (element.children.length && depth < 3) {
    result.children = element.children.map(
      (child) => simplifyTree(child, depth + 1)
    );
  }
  return result;
}
