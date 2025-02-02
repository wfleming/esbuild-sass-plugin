import {dirname, parse, relative, resolve, sep} from 'path'
import fs from "node:fs/promises"
import {createResolver, fileSyntax, sourceMappingURL} from './utils'
import {PartialMessage} from 'esbuild'
import * as sass from 'sass-embedded'
import {ImporterResult} from 'sass-embedded'
import {fileURLToPath, pathToFileURL} from 'url'
import {SassPluginOptions} from './index'

export type RenderSync = (path: string) => Promise<RenderResult>

export type RenderResult = {
  cssText: string
  watchFiles: string[]
  warnings?: PartialMessage[]
}

export function createRenderer(options: SassPluginOptions = {}, sourcemap: boolean): RenderSync {

  const loadPaths = options.loadPaths!
  const resolveModule = createResolver(options, loadPaths)

  async function fsExists(path) {
    try {
      await fs.stat(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * NOTE: we're deliberately ignoring sass recommendation to avoid sacrificing speed here!
   * - we prefer fragment attempt over syntax attempt
   * - we prefer .scss and .css over .sass
   * - we don't throw exceptions if the URL is ambiguous
   */
  async function resolveImport(pathname: string, ext?: string): Promise<string | null> {
    if (ext) {
      let filename = pathname + ext
      if (await fsExists(filename)) {
        return filename
      }
      const index = filename.lastIndexOf(sep)
      filename = index >= 0 ? filename.slice(0, index) + sep + '_' + filename.slice(index + 1) : '_' + filename
      if (await fsExists(filename)) {
        return filename
      }
      return null
    } else {
      if (!await fsExists(dirname(pathname))) {
        return null
      }
      return await resolveImport(pathname, '.scss')
        || await resolveImport(pathname, '.css')
        || await resolveImport(pathname, '.sass')
        || await resolveImport(pathname + sep + 'index')
    }
  }

  async function resolveRelativeImport(loadPath: string, filename: string): Promise<string | null> {
    const absolute = resolve(loadPath, filename)
    const pathParts = parse(absolute)
    if (pathParts.ext) {
      return resolveImport(pathParts.dir + sep + pathParts.name, pathParts.ext)
    } else {
      return resolveImport(absolute)
    }
  }

  const sepTilde = `${sep}~`

  /**
   * renderSync
   */
  return async function (path: string): Promise<RenderResult> {

    const basedir = dirname(path)

    let source = await fs.readFile(path, 'utf-8')
    if (options.precompile) {
      source = options.precompile(source, path, true)
    }

    const syntax = fileSyntax(path)
    if (syntax === 'css') {
      return {cssText: await fs.readFile(path, 'utf-8'), watchFiles: [path]}
    }

    if (options.quietDeps) {
      options.url = pathToFileURL(path)
    }

    const warnings: PartialMessage[] = []
    const logger = options.logger ?? {
      warn: function (message, opts) {
        if (!opts.span) {
          warnings.push({ text: `sass warning: ${message}` })
        } else {
          const filename = opts.span.url?.pathname ?? path
          const esbuildMsg = {
            text: message,
            location: {
              file: filename,
              line: opts.span.start.line,
              column: opts.span.start.column,
              lineText: opts.span.text,
            },
            detail: {
              deprecation: opts.deprecation,
              stack: opts.stack,
            }
          }

          warnings.push(esbuildMsg)
        }
      }
    }

    const {
      css,
      loadedUrls,
      sourceMap
    } = await sass.compileStringAsync(source, {
      sourceMapIncludeSources: true,
      ...options,
      logger,
      syntax,
      importer: {
        async load(canonicalUrl: URL): Promise<ImporterResult | null> {
          const pathname = fileURLToPath(canonicalUrl)
          let contents = await fs.readFile(pathname, 'utf8')
          if (options.precompile) {
            contents = options.precompile(contents, pathname, false)
          }
          return {
            contents,
            syntax: fileSyntax(pathname),
            sourceMapUrl: sourcemap ? canonicalUrl : undefined
          }
        },
        async canonicalize(url: string): Promise<URL | null> {
          let filename: string
          if (url.startsWith('~')) {
            filename = resolveModule(decodeURI(url.slice(1)), basedir)
          } else if (url.startsWith('file://')) {
            filename = fileURLToPath(url)
            // ================================================ patch for: https://github.com/sass/dart-sass/issues/1581
            let joint = filename.lastIndexOf(sepTilde)
            if (joint >= 0) {
              filename = resolveModule(filename.slice(joint + 2), filename.slice(0, joint))
            }
            // =========================================================================================================
          } else {
            filename = decodeURI(url)
          }
          if (options.importMapper) {
            filename = options.importMapper(filename)
          }
          let resolved = await resolveRelativeImport(basedir, filename)
          if (resolved) {
            return pathToFileURL(resolved)
          }
          for (const loadPath of loadPaths) {
            resolved = await resolveRelativeImport(loadPath, filename)
            if (resolved) {
              return pathToFileURL(resolved)
            }
          }
          return null
        }
      },
      sourceMap: sourcemap
    })

    let cssText = css.toString()

    if (sourceMap) {
      sourceMap.sourceRoot = basedir
      sourceMap.sources = sourceMap.sources.map(source => {
        return relative(basedir, source.startsWith('data:') ? path : fileURLToPath(source))
      })
      cssText += '\n' + sourceMappingURL(sourceMap)
    }

    return {
      cssText,
      warnings: warnings,
      watchFiles: [path, ...loadedUrls.map(fileURLToPath)]
    }
  }
}
