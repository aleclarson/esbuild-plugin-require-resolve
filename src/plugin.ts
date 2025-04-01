import { Node, parse, walk } from '@chialab/estransform'
import type { Plugin } from 'esbuild'
import { File, getBuildExtensions } from 'esbuild-extra'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A file loader plugin for esbuild for `require.resolve` statements.
 * @returns An esbuild plugin.
 */
export default function () {
  const plugin: Plugin = {
    name: 'require-resolve',
    setup(build) {
      const { initialOptions } = build
      const { sourcemap, sourcesContent } = initialOptions
      const workingDir = path.resolve(initialOptions.absWorkingDir ?? '.')

      const { onTransform, emitFile, emitChunk } = getBuildExtensions(
        build,
        'require-resolve'
      )

      const pathsToRewrite = new Map<string, string>()
      const nodeExtensionRegex = /\brequire\s*\(\s*["'][^"']+\.node["']\s*\)/

      onTransform({ loaders: ['tsx', 'ts', 'jsx', 'js'] }, async args => {
        const usingRequireResolve = args.code.includes('require.resolve')
        const usingNativeRequire = nodeExtensionRegex.test(args.code)

        if (!usingRequireResolve && !usingNativeRequire) {
          return
        }

        const { ast, helpers } = await parse(
          args.code,
          path.relative(workingDir, args.path)
        )

        const rewriteNativeRequire = async (node: Node) => {
          if (
            node.callee.type !== 'Identifier' ||
            node.callee.name !== 'require'
          ) {
            return
          }

          const [arg] = node.arguments
          if (arg.type !== 'StringLiteral') {
            return
          }

          const id = arg.value
          if (!id.endsWith('.node')) {
            return
          }

          const resolvedFilePath = path.resolve(path.dirname(args.path), id)
          if (!fs.existsSync(resolvedFilePath)) {
            return
          }

          const emittedFile = await emitFile(resolvedFilePath)

          const placeholderId = '__' + emittedFile.id
          pathsToRewrite.set(placeholderId, emittedFile.filePath)
          helpers.overwrite(arg.start, arg.end, `'${placeholderId}'`)
        }

        const rewriteRequireResolve = async (node: Node) => {
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

          const id = argument.value
          const { path: resolvedFilePath } = await build.resolve(id, {
            kind: 'require-resolve',
            importer: args.path,
            resolveDir: path.dirname(args.path),
          })
          if (!resolvedFilePath) {
            return
          }
          if (!fs.existsSync(resolvedFilePath)) {
            return
          }

          let emittedFile: File
          if (/\.[mc]?js$/.test(resolvedFilePath)) {
            emittedFile = await emitChunk({
              path: resolvedFilePath,
            })
          } else {
            emittedFile = await emitFile(resolvedFilePath)
          }

          const placeholderId = '__' + emittedFile.id
          pathsToRewrite.set(placeholderId, emittedFile.filePath)
          helpers.overwrite(argument.start, argument.end, `'${placeholderId}'`)
        }

        await walk(ast, {
          async CallExpression(node) {
            if (usingNativeRequire) {
              await rewriteNativeRequire(node)
            }
            if (usingRequireResolve) {
              await rewriteRequireResolve(node)
            }
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
              for (const [placeholder, filePath] of pathsToRewrite) {
                content = content.replace(placeholder, () => {
                  return resolveRelativeImport(outputFile.path, filePath)
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
