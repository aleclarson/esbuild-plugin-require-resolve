import { Node, parse, walk } from '@chialab/estransform'
import type { Plugin } from 'esbuild'
import { File, getBuildExtensions } from 'esbuild-extra'
import fs from 'node:fs'
import path from 'node:path'
import spawn from 'tinyspawn'

type Options = {
  /**
   * The directory to load native dependencies from.
   *
   * @default "./"
   */
  installDir?: string
}

/**
 * A file loader plugin for esbuild for `require.resolve` statements.
 * @returns An esbuild plugin.
 */
export default function (options: Options = {}) {
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

      const libraries = new Map<string, File>()
      const emitLibraries = async (targetPath: string) => {
        try {
          // Run otool to get dependencies
          const otoolResult = await spawn('otool', ['-L', targetPath])

          // Parse the output to find @loader_path dependencies
          const loaderDependencies = otoolResult.stdout
            .split('\n')
            .filter(line => line.includes('@loader_path'))
            .map(line => {
              const match = line.trim().match(/^\s*(@loader_path\/[^\s]+)/)
              return match ? match[1] : null
            })
            .filter(Boolean) as string[]

          const loaderPaths = [
            path.dirname(targetPath),
            ...(process.env.DYLD_LIBRARY_PATH?.split(':').filter(Boolean) ?? [
              '/opt/homebrew/lib',
            ]),
          ]

          // Resolve and emit each dependency
          for (const dep of loaderDependencies) {
            const name = dep.replace('@loader_path/', '')
            if (libraries.has(name)) {
              continue
            }
            const dir = loaderPaths.find(p =>
              fs.existsSync(path.resolve(p, name))
            )
            if (dir) {
              const resolvedFilePath = dep.replace('@loader_path', dir)
              libraries.set(name, await emitFile(resolvedFilePath))

              // Recursively emit dependencies
              await emitLibraries(resolvedFilePath)
            } else {
              console.warn(
                `[esbuild-plugin-require-resolve] Could not find dependency ${dep}`
              )
            }
          }
        } catch (error) {
          // Log error but continue - otool might not be available on all platforms
          console.warn(
            `[esbuild-plugin-require-resolve] Failed to process native dependencies for ${targetPath}:`,
            error
          )
        }
      }

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
          await emitLibraries(resolvedFilePath)

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
                  if (options.installDir) {
                    const installDir =
                      initialOptions.outdir ?? path.dirname(outputFile.path)
                    return path.resolve(
                      installDir,
                      options.installDir,
                      path.relative(installDir, filePath)
                    )
                  }
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
