declare const __HOMEKIT_BRIDGE_VERSION__: string | undefined;

/** Injected by build.mjs from package.json; "dev" when run from source. */
export const VERSION: string =
  typeof __HOMEKIT_BRIDGE_VERSION__ === "string" ? __HOMEKIT_BRIDGE_VERSION__ : "0.0.0-dev";
