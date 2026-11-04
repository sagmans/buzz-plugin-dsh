// Every `react` import in the bundle resolves here (vite.config.js), so the
// buzz-app components this plugin bundles (ModelPicker, AgentInstructions,
// the design system) render with Buzz's own React, from `ctx.react`. A
// second React would break hooks: Buzz renders the plugin's components, and
// hooks only work with the React that renders them.
//
// The bundle evaluates before `apply(ctx)` hands over Buzz's React, and some
// modules call React when they load (createContext, forwardRef, memo). Those
// calls make plain objects, keyed by global symbols, that any React of the
// same version accepts, so they use the bundled copy until `bindReact` runs.
// Every function export forwards to the bound React at call time, so a hook
// a module kept in a variable while it loaded still reaches Buzz's React.
import * as Bundled from "react-bundled";

/** The React that hooks reach: the bundled copy until `bindReact` runs. */
let current = Bundled;

/** Binds Buzz's React; `apply(ctx)` calls it before it registers any view. */
export function bindReact(react) {
  if (react.version !== Bundled.version)
    throw new Error(
      `This build bundles React ${Bundled.version}, but Buzz runs React ${react.version}. Rebuild the plugin for this Buzz version.`,
    );
  current = react;
}

/** A stable function that calls the bound React's export of that name. */
function forward(name) {
  return (...args) => current[name](...args);
}

// Element type tags and classes: global symbols and plain classes, the same
// in any React of this version.
export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  version,
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  __COMPILER_RUNTIME,
} = Bundled;

export const act = forward("act");
export const cache = forward("cache");
export const cacheSignal = forward("cacheSignal");
export const captureOwnerStack = forward("captureOwnerStack");
export const cloneElement = forward("cloneElement");
export const createContext = forward("createContext");
export const createElement = forward("createElement");
export const createRef = forward("createRef");
export const forwardRef = forward("forwardRef");
export const isValidElement = forward("isValidElement");
export const lazy = forward("lazy");
export const memo = forward("memo");
export const startTransition = forward("startTransition");
export const unstable_useCacheRefresh = forward("unstable_useCacheRefresh");
export const use = forward("use");
export const useActionState = forward("useActionState");
export const useCallback = forward("useCallback");
export const useContext = forward("useContext");
export const useDebugValue = forward("useDebugValue");
export const useDeferredValue = forward("useDeferredValue");
export const useEffect = forward("useEffect");
export const useEffectEvent = forward("useEffectEvent");
export const useId = forward("useId");
export const useImperativeHandle = forward("useImperativeHandle");
export const useInsertionEffect = forward("useInsertionEffect");
export const useLayoutEffect = forward("useLayoutEffect");
export const useMemo = forward("useMemo");
export const useOptimistic = forward("useOptimistic");
export const useReducer = forward("useReducer");
export const useRef = forward("useRef");
export const useState = forward("useState");
export const useSyncExternalStore = forward("useSyncExternalStore");
export const useTransition = forward("useTransition");

const all = {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  version,
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  __COMPILER_RUNTIME,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};
// CommonJS modules (react-dom) read React as a default import.
export default all;
