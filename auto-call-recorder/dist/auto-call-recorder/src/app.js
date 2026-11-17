"use strict";

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, {
    get: all[name],
    enumerable: true
  });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    var _loop = function (key) {
      if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
        get: () => from[key],
        enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
      });
    };
    for (var key of __getOwnPropNames(from)) {
      _loop(key);
    }
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", {
  value: true
}), mod);

// swipt-automation-examples/auto-call-recorder/src/App.tsx
var App_exports = {};
__export(App_exports, {
  default: () => App
});
module.exports = __toCommonJS(App_exports);
var import_swift_ui = require("@swipt/api/swift-ui");
var import_jsx_runtime = require("react/jsx-runtime");
function App() {
  return (0, import_jsx_runtime.jsxs)(import_swift_ui.View, {
    style: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center"
    },
    children: [(0, import_jsx_runtime.jsx)(import_swift_ui.Text, {
      style: {
        fontSize: 20,
        fontWeight: "bold"
      },
      children: "\u81EA\u52A8\u901A\u8BDD\u5F55\u97F3"
    }), (0, import_jsx_runtime.jsx)(import_swift_ui.Text, {
      style: {
        marginTop: 8,
        color: "secondaryLabel"
      },
      children: "\u670D\u52A1\u8FD0\u884C\u65F6\uFF0C\u63A5\u6253\u7535\u8BDD\u4F1A\u81EA\u52A8\u70B9\u51FB\u300C\u901A\u8BDD\u5F55\u97F3\u300D\u3002"
    })]
  });
}