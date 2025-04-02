# esbuild-plugin-require-resolve

Find any `require.resolve` calls in your bundle, copy the resolved files to the output directory, and rewrite the import paths to be relative to the output file.

This uses [esbuild-extra](https://github.com/aleclarson/esbuild-extra) to support chained transforms. (Credit to [@chialab/esbuild-plugin-require-resolve](https://github.com/chialab/rna/tree/main/packages/esbuild-plugin-require-resolve) for the original implementation.)

```
pnpm add esbuild-plugin-require-resolve
```

## Usage

```ts
import requireResolvePlugin from 'esbuild-plugin-require-resolve'
import esbuild from 'esbuild'

await esbuild.build({
  plugins: [requireResolvePlugin()],
})
```

## Options

You can pass an options object to the plugin:

```ts
import requireResolvePlugin from 'esbuild-plugin-require-resolve'
import esbuild from 'esbuild'

await esbuild.build({
  plugins: [
    requireResolvePlugin({
      // Options go here
    }),
  ],
})
```

### `installDir`

- **Type:** `string`
- **Default:** `undefined`

This option allows you to specify a directory prefix for the rewritten `require` and `require.resolve` paths. When `installDir` is provided, the plugin calculates the final path like this:

```ts
path.resolve(outputDir, installDir, relativePathToDependency)
```

- **outputDir**: This is the esbuild `outdir` if specified, otherwise it's the directory of the output bundle file. (Won't be used if `installDir` is absolute.)
- **installDir**: The value you provide for this option.
- **relativePathToDependency**: The path from the `outputDir` to the copied dependency file.

This is useful if you need the resolved paths in your bundled code to point to a specific installation directory structure (prefixed by `installDir`) relative to your main output directory, rather than being directly relative to the output bundle file itself.

## Handling Native Node Modules (`.node` files)

The plugin automatically detects `require()` calls that target `.node` files (native Node.js addons). It performs the following actions:

1.  Copies the referenced `.node` file to the esbuild output directory.
2.  Rewrites the `require()` call in your bundled code to correctly point to the copied file's new location relative to the output file.

This ensures that native modules used by your project are included in the build output and can be loaded correctly at runtime.

## Automatic Dependency Copying for `.node` Files (macOS)

When a `.node` file is processed on macOS, the plugin goes a step further:

1.  It uses the `otool -L` command to inspect the `.node` file and identify any linked shared libraries (dependencies) that use `@loader_path`.
2.  It attempts to locate these dependent libraries (e.g., `.dylib` files) in common paths like `/opt/homebrew/lib` or paths specified in the `DYLD_LIBRARY_PATH` environment variable.
3.  Found dependencies are also copied to the esbuild output directory, ensuring the native addon can find its own required libraries at runtime.

**Note:** This automatic dependency discovery currently relies on the `otool` command and is specific to macOS.
