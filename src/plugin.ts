import { parse, walk } from '@chialab/estransform'
import type { Plugin } from 'esbuild'
import { getBuildExtensions } from 'esbuild-extra'
import path from 'node:path'

/**
 * A file loader plugin for esbuild for `require.resolve` statements.
 * @returns An esbuild plugin.
 */
export default function () {
  const plugin: Plugin = {
    name: 'require-resolve',
    setup(build) {
      const { onTransform, emitFile } = getBuildExtensions(
        build,
        'require-resolve'
      )

      const { initialOptions } = build
      const { sourcesContent, sourcemap } = initialOptions
      const workingDir = initialOptions.absWorkingDir ?? process.cwd()

      const pathsToRewrite = new Map<string, string>()

      onTransform({ loaders: ['tsx', 'ts', 'jsx', 'js'] }, async args => {
        if (!args.code.includes('require.resolve')) {
          return
        }

        const { ast, helpers } = await parse(
          args.code,
          path.relative(workingDir, args.path)
        )
        await walk(ast, {
          async CallExpression(node) {
            if (
              node.callee.type !== 'StaticMemberExpression' ||
              node.callee.object.type !== 'Identifier' ||
              node.callee.object.name !== 'require' ||
              node.callee.property.type !== 'Identifier' ||
              node.callee.property.name !== 'resolve'
            ) {
              return
            }

            const argument = node.arguments[0]
            if (argument.type !== 'StringLiteral') {
              return
            }

            const fileName = argument.value
            const { path: resolvedFilePath } = await build.resolve(fileName, {
              kind: 'require-resolve',
              importer: args.path,
              resolveDir: path.dirname(args.path),
            })
            if (!resolvedFilePath) {
              return
            }

            const emittedFile = await emitFile(resolvedFilePath)
            const placeholderId = '__' + emittedFile.id
            pathsToRewrite.set(placeholderId, emittedFile.filePath)

            helpers.overwrite(
              argument.start,
              argument.end,
              `'${placeholderId}'`
            )
          },
        })

        if (!helpers.isDirty()) {
          return
        }

        return helpers.generate({
          sourcemap: !!sourcemap,
          sourcesContent,
        })
      })

      build.onResolve({ filter: /^__/ }, args => {
        if (pathsToRewrite.has(args.path)) {
          return {
            path: args.path,
            external: true,
          }
        }
      })

      build.onEnd(result => {
        if (result.outputFiles) {
          const resolveRelativeImport = (
            importer: string,
            importee: string
          ) => {
            const relative = path.relative(path.dirname(importer), importee)
            return relative.startsWith('../') ? relative : './' + relative
          }

          for (const outputFile of result.outputFiles) {
            if (/\.[mc]?js$/.test(outputFile.path)) {
              let content = outputFile.text
              for (const [placeholder, replacement] of pathsToRewrite) {
                content = content.replace(placeholder, () => {
                  return resolveRelativeImport(outputFile.path, replacement)
                })
              }
              outputFile.contents = new TextEncoder().encode(content)
            }
          }
        }
      })
    },
  }

  return plugin
}
