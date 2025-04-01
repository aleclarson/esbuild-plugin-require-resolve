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
