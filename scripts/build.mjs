import { build } from "esbuild";

await build({
    entryPoints: ["src/tui.tsx"],
    outfile: "dist/tui.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    jsx: "automatic",
    jsxImportSource: "@opentui/solid",
    packages: "external",
});
