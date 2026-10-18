// SPDX-License-Identifier: MPL-2.0
// The Basis Universal transcoder three.js ships (libs/basis/basis_transcoder.js: Basis Universal,
// Apache-2.0, built by Emscripten, MIT) writes two of its embind helpers as source text and builds
// them with `Function`. The client's page policy forbids evaluating text as script (script-src has
// 'wasm-unsafe-eval' and no 'unsafe-eval'), and KTX2Loader's worker, started from a blob: URL,
// inherits that policy: the transcoder's start threw inside the worker, its ready promise never
// settled, and every KTX2 texture waited for an answer that never came. Textured worlds and every
// avatar converted with KTX2 never finished loading (found in S4.12; the bundled worlds have no
// textures, and the tests converted without KTX2). withoutEval swaps the two helpers for the
// closures Emscripten writes itself when built with DYNAMIC_EXECUTION=0, and refuses a transcoder
// whose text it does not know, so a three.js update that changes the file fails
// test/basis-transcoder.test.ts rather than the client.

export class TranscoderError extends Error {}

/** craftInvokerFunction's generated invoker: every bound C++ function and method. */
const INVOKER = "let[args,invokerFnBody]=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);args.push(invokerFnBody);var invokerFn=newFunc(Function,args)(...closureArgs);";
const INVOKER_CLOSURE = `
var dtors = argTypes.map((t) => (t === null ? null : t.destructorFunction));
var invokerFn = function (...given) {
  if (given.length !== argCount - 2) {
    throwBindingError('function ' + humanName + ' called with ' + given.length + ' arguments, expected ' + (argCount - 2));
  }
  var destructors = needsDestructorStack ? [] : null;
  var thisWired;
  if (isClassMethodFunc) thisWired = argTypes[1]['toWireType'](destructors, this);
  var argsWired = [];
  for (var i = 0; i < argCount - 2; ++i) argsWired.push(argTypes[i + 2]['toWireType'](destructors, given[i]));
  var rv = isClassMethodFunc ? cppInvokerFunc(cppTargetFunc, thisWired, ...argsWired) : cppInvokerFunc(cppTargetFunc, ...argsWired);
  if (needsDestructorStack) {
    runDestructors(destructors);
  } else {
    for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
      if (dtors[i] !== null) dtors[i](i === 1 ? thisWired : argsWired[i - 2]);
    }
  }
  if (returns) return argTypes[0]['fromWireType'](rv);
};
`;

/** __emval_get_method_caller's generated caller: C++ calling a JavaScript method or constructor
 *  through emscripten::val (the transcoder fills the caller's typed arrays this way). */
const METHOD_CALLER = "var functionBody=`return function (obj, func, destructorsRef, args) {\\n`;var offset=0;var argsList=[];if(kind===0){argsList.push(\"obj\")}var params=[\"retType\"];var args=[retType];for(var i=0;i<argCount;++i){argsList.push(\"arg\"+i);params.push(\"argType\"+i);args.push(types[i]);functionBody+=`  var arg${i} = argType${i}.readValueFromPointer(args${offset?\"+\"+offset:\"\"});\\n`;offset+=types[i][\"argPackAdvance\"]}var invoker=kind===1?\"new func\":\"func.call\";functionBody+=`  var rv = ${invoker}(${argsList.join(\", \")});\\n`;if(!retType.isVoid){params.push(\"emval_returnValue\");args.push(emval_returnValue);functionBody+=\"  return emval_returnValue(retType, destructorsRef, rv);\\n\"}functionBody+=\"};\\n\";params.push(functionBody);var invokerFunction=newFunc(Function,params)(...args);";
const METHOD_CALLER_CLOSURE = `
var invokerFunction = function (obj, func, destructorsRef, args) {
  var list = kind === 0 ? [obj] : [];
  var offset = 0;
  for (var i = 0; i < argCount; ++i) {
    list.push(types[i].readValueFromPointer(args + offset));
    offset += types[i]['argPackAdvance'];
  }
  var rv = kind === 1 ? reflectConstruct(func, list) : func.call(...list);
  if (!retType.isVoid) return emval_returnValue(retType, destructorsRef, rv);
};
`;

/** The transcoder's source with no evaluation of text left in it. */
export function withoutEval(js: string): string {
  let out = js;
  for (const [from, to] of [
    [INVOKER, INVOKER_CLOSURE],
    [METHOD_CALLER, METHOD_CALLER_CLOSURE],
  ] as const) {
    if (out.split(from).length !== 2) throw new TranscoderError('the Basis transcoder is not the one this patch knows (three.js changed it): read its embind helpers again');
    out = out.replace(from, () => to);
  }
  if (out.includes('newFunc(Function')) throw new TranscoderError('the Basis transcoder still builds a function from text');
  return out;
}
