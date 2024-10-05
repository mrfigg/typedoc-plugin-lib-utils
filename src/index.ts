/**
 * @packageDocumentation
 *
 * Miscellaneous utility functions for TypeDoc plugins.
 *
 * @document ../CHANGELOG.md
 * @document ../LICENSE
 */

'use strict'

import { resolve, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib'
import { promisify } from 'node:util'

import {
  Application,
  Comment,
  DeclarationReflection,
  DefaultTheme,
  DocumentReflection,
  EntryPointStrategy,
  IndexEvent,
  ProjectReflection,
  Reflection,
  ReflectionKind,
  RendererEvent,
} from 'typedoc'

import { Builder, trimmer } from 'lunr'
import commondir from 'commondir'
import escalade from 'escalade/sync'

const gunzip = promisify(gunzipCallback)
const gzip = promisify(gzipCallback)

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONObject
  | JSONArray

export type JSONObject = { [member: string]: JSONValue }

export type JSONArray = Array<JSONValue>

export function isJSONValue(value: unknown): value is JSONValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((value) => isJSONValue(value))
  }

  if (typeof value === 'object') {
    return Object.values(value).every((value) => isJSONValue(value))
  }

  return false
}

export function isJSONObject(value: unknown): value is JSONObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  return Object.values(value).every((value) => isJSONValue(value))
}

export function isJSONArray(value: unknown): value is JSONArray {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((value) => isJSONValue(value))
}

export async function readGzipJson(file: string, jsVariable?: string) {
  let content = await readFile(file, {
    // TODO: detect encoding?
    encoding: 'utf8',
  })

  if (jsVariable) {
    content = content.replace(
      new RegExp(
        `^${jsVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} = "([^"]*)";?$`
      ),
      '$1'
    )
  }

  content = content.replace(/^data:application\/octet-stream;base64,/, '')

  let buffer = Buffer.from(content, 'base64')

  buffer = await gunzip(buffer)

  return JSON.parse(buffer.toString()) as JSONValue
}

export async function writeGzipJson(
  file: string,
  value: JSONValue,
  jsVariable?: string
) {
  let buffer = Buffer.from(JSON.stringify(value))

  buffer = await gzip(buffer)

  let content = buffer.toString('base64')

  content = `data:application/octet-stream;base64,${content}`

  if (jsVariable) {
    content = `${jsVariable} = "${content}";`
  }

  // TODO: encoding?
  await writeFile(file, content)
}

/** @deprecated */
export type Search = {
  rows: SearchItem[]
} & Readonly<{
  index: Readonly<object>
}>

export type SearchItem = {
  url: string
  kind?: ReflectionKind
  name?: string
  classes?: string
  parent?: string
  comment?: string
  document?: string
  boost?: number
}

export type AlterSearchCallback = (
  items: SearchItem[],
  context: { app: Application; event: RendererEvent }
) => void | Promise<void>

export type FormatSearchCallback = (
  item: SearchItem & Readonly<{ url: string }>,
  context: {
    app: Application
    event: RendererEvent
    reflection?: DeclarationReflection | DocumentReflection
  }
) => void | Promise<void>

/** @deprecated Use {@link alterSearch} and {@link formatSearch} instead. */
export async function readSearch(app: Application) {
  return (await readGzipJson(
    resolve(app.options.getValue('out'), 'assets', 'search.js'),
    'window.searchData'
  )) as Search
}

/** @deprecated Use {@link alterSearch} and {@link formatSearch} instead. */
export function rebuildSearch(
  search: Search,
  app: Application,
  event: RendererEvent,
  options?: {
    formatName?: (
      name: string | undefined,
      reflection: DeclarationReflection | DocumentReflection | undefined
    ) => string | undefined
    formatComment?: (
      comment: string | undefined,
      reflection: DeclarationReflection | DocumentReflection | undefined
    ) => string | undefined
    formatDocument?: (
      document: string | undefined,
      reflection: DeclarationReflection | DocumentReflection | undefined
    ) => string | undefined
  }
) {
  const searchInComments = !!app.options.getValue('searchInComments')
  const searchInDocuments = !!app.options.getValue('searchInDocuments')

  const theme = app.renderer.theme! as DefaultTheme

  const reflections = Object.values(event.project.reflections).filter(
    (reflection) =>
      (reflection instanceof DeclarationReflection ||
        reflection instanceof DocumentReflection) &&
      reflection.url &&
      reflection.name &&
      !reflection.flags.isExternal
  ) as (DeclarationReflection | DocumentReflection)[]

  const indexEvent = new IndexEvent(reflections)

  app.renderer.trigger(IndexEvent.PREPARE_INDEX, indexEvent)

  const builder = new Builder()
  builder.pipeline.add(trimmer)

  builder.ref('id')

  for (const [key, boost] of Object.entries(indexEvent.searchFieldWeights)) {
    builder.field(key, { boost })
  }

  for (const [id, row] of search.rows.entries()) {
    if (!row.url) {
      continue
    }

    const reflectionIndex = reflections.findIndex(
      (reflection) => reflection.url === row.url
    )
    const reflection =
      reflectionIndex === -1 ? undefined : reflections[reflectionIndex]

    if (reflection) {
      if (row.kind === undefined) {
        row.kind = reflection.kind
      }

      if (row.name === undefined) {
        row.name = reflection.name
      }

      if (row.classes === undefined) {
        row.classes = theme.getReflectionClasses(reflection)
      }

      if (row.parent === undefined) {
        let parent = reflection.parent

        if (parent instanceof ProjectReflection) {
          parent = undefined
        }

        if (parent) {
          row.parent = parent.getFullName()
        }
      }

      if (row.comment === undefined && searchInComments) {
        const comments: Comment[] = []

        if (reflection.comment) {
          comments.push(reflection.comment)
        }

        if (reflection.isDeclaration()) {
          for (const signature of reflection.signatures ?? []) {
            if (!signature.comment) {
              continue
            }

            comments.push(signature.comment)
          }

          if (reflection.getSignature?.comment) {
            comments.push(reflection.getSignature.comment)
          }

          if (reflection.setSignature?.comment) {
            comments.push(reflection.setSignature.comment)
          }
        }

        if (comments.length) {
          row.comment = comments
            .flatMap((comment) => [
              ...comment.summary,
              ...comment.blockTags.flatMap((token) => token.content),
            ])
            .map((part) => part.text)
            .join('\n')
        }
      }

      if (
        row.document === undefined &&
        searchInDocuments &&
        reflection.isDocument()
      ) {
        row.document = reflection.content
          .flatMap((part) => part.text)
          .join('\n')
      }

      if (row.boost === undefined) {
        row.boost = reflection.relevanceBoost ?? 1

        if (row.boost <= 0) {
          row.boost = 1
        }
      }
    }

    if (options?.formatName) {
      row.name = options.formatName(row.name, reflection)
    }

    if (options?.formatComment) {
      row.comment = options.formatComment(row.comment, reflection)
    }

    if (options?.formatDocument) {
      row.document = options.formatDocument(row.document, reflection)
    }

    builder.add(
      {
        name: row.name,
        comment: row.comment,
        document: row.document,
        ...(reflection ? indexEvent.searchFields[reflectionIndex] : {}),
        id,
      },
      {
        boost: row.boost,
      }
    )

    delete row.comment
    delete row.document
    delete row.boost
  }

  // ignore read-only internally
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(search as any).index = builder.build().toJSON()

  return search
}

/** @deprecated Use {@link alterSearch} and {@link formatSearch} instead. */
export async function writeSearch(app: Application, search: Search) {
  await writeGzipJson(
    resolve(app.options.getValue('out'), 'assets', 'search.js'),
    search as unknown as JSONValue,
    'window.searchData'
  )
}

const searchTasksStore = new WeakMap<
  Application,
  {
    alter: AlterSearchCallback[]
    format: FormatSearchCallback[]
  }
>()

function getSearchTasks(app: Application) {
  if (searchTasksStore.has(app)) {
    return searchTasksStore.get(app)!
  }

  const searchTasks: {
    alter: AlterSearchCallback[]
    format: FormatSearchCallback[]
  } = { alter: [], format: [] }

  searchTasksStore.set(app, searchTasks)

  app.renderer.postRenderAsyncJobs.push(async (event) => {
    const search = (await readGzipJson(
      resolve(app.options.getValue('out'), 'assets', 'search.js'),
      'window.searchData'
    )) as {
      rows: SearchItem[]
      index: object
    }

    for (const alter of searchTasks.alter) {
      await alter(search.rows, { app, event })
    }

    const searchInComments = !!app.options.getValue('searchInComments')
    const searchInDocuments = !!app.options.getValue('searchInDocuments')

    const theme = app.renderer.theme! as DefaultTheme

    const reflections = Object.values(event.project.reflections).filter(
      (reflection) =>
        (reflection instanceof DeclarationReflection ||
          reflection instanceof DocumentReflection) &&
        reflection.url &&
        reflection.name &&
        !reflection.flags.isExternal
    ) as (DeclarationReflection | DocumentReflection)[]

    const indexEvent = new IndexEvent(reflections)

    app.renderer.trigger(IndexEvent.PREPARE_INDEX, indexEvent)

    const builder = new Builder()
    builder.pipeline.add(trimmer)

    builder.ref('id')

    for (const [key, boost] of Object.entries(indexEvent.searchFieldWeights)) {
      builder.field(key, { boost })
    }

    for (const [id, item] of search.rows.entries()) {
      const reflectionIndex = reflections.findIndex(
        (reflection) => reflection.url === item.url
      )

      const reflection =
        reflectionIndex === -1 ? undefined : reflections[reflectionIndex]

      if (reflection) {
        if (item.kind === undefined) {
          item.kind = reflection.kind
        }

        if (item.name === undefined) {
          item.name = reflection.name
        }

        if (item.classes === undefined) {
          item.classes = theme.getReflectionClasses(reflection)
        }

        if (item.parent === undefined) {
          let parent = reflection.parent

          if (parent instanceof ProjectReflection) {
            parent = undefined
          }

          if (parent) {
            item.parent = parent.getFullName()
          }
        }

        if (item.comment === undefined && searchInComments) {
          const comments: Comment[] = []

          if (reflection.comment) {
            comments.push(reflection.comment)
          }

          if (reflection.isDeclaration()) {
            for (const signature of reflection.signatures ?? []) {
              if (!signature.comment) {
                continue
              }

              comments.push(signature.comment)
            }

            if (reflection.getSignature?.comment) {
              comments.push(reflection.getSignature.comment)
            }

            if (reflection.setSignature?.comment) {
              comments.push(reflection.setSignature.comment)
            }
          }

          if (comments.length) {
            item.comment = comments
              .flatMap((comment) => [
                ...comment.summary,
                ...comment.blockTags.flatMap((token) => token.content),
              ])
              .map((part) => part.text)
              .join('\n')
          }
        }

        if (
          item.document === undefined &&
          searchInDocuments &&
          reflection.isDocument()
        ) {
          item.document = reflection.content
            .flatMap((part) => part.text)
            .join('\n')
        }

        if (item.boost === undefined) {
          item.boost = reflection.relevanceBoost ?? 1
        }
      }

      for (const format of searchTasks.format) {
        await format(item, { app, event, reflection })
      }

      if (item.url && (item.boost === undefined || item.boost > 0)) {
        builder.add(
          {
            name: item.name,
            comment: item.comment,
            document: item.document,
            ...(reflection ? indexEvent.searchFields[reflectionIndex] : {}),
            id,
          },
          {
            boost: item.boost ?? 1,
          }
        )
      }

      item.name = item.name ?? ''
      delete item.comment
      delete item.document
      delete item.boost
    }

    search.index = builder.build().toJSON()

    await writeGzipJson(
      resolve(app.options.getValue('out'), 'assets', 'search.js'),
      search as JSONValue,
      'window.searchData'
    )
  })

  return searchTasks
}

/**
 * @example
 *
 * ```ts
 * import { Application, ReflectionKind } from 'typedoc'
 *
 * export function load(app: Application) {
 *   alterSearch(app, (items) => {
 *     items.unshift({
 *       url: 'foo.html#bar',
 *       name: 'Foo',
 *       kind: ReflectionKind.Document,
 *       comment: undefined,
 *       document: 'Lorem ipsum dolor sit amet...'
 *     })
 *   })
 * }
 * ```
 */
export function alterSearch(app: Application, callback: AlterSearchCallback) {
  getSearchTasks(app).alter.push(callback)
}

/**
 * @example
 *
 * ```ts
 * import { Application } from 'typedoc'
 *
 * export function load(app: Application) {
 *   formatSearch(app, (item) => {
 *     if (!item.document) {
 *       return
 *     }
 *
 *     item.document = item.document.replace(/foo/g, 'bar')
 *   })
 * }
 * ```
 */
export function formatSearch(app: Application, callback: FormatSearchCallback) {
  getSearchTasks(app).format.push(callback)
}

export type NavigationItem = {
  path: string
  text: string
  kind: ReflectionKind
  class?: string
  children?: NavigationItem[]
}

export type AlterNavigationCallback = (
  items: NavigationItem[],
  context: { app: Application; event: RendererEvent }
) => void | Promise<void>

export type FormatNavigationCallback = (
  item: Omit<NavigationItem, 'children'> & Readonly<{ path: string }>,
  context: {
    app: Application
    event: RendererEvent
    reflection?: Reflection
  }
) => void | Promise<void>

/** @deprecated Use {@link alterNavigation} instead. */
export async function readNavigation(app: Application) {
  return (await readGzipJson(
    resolve(app.options.getValue('out'), 'assets', 'navigation.js'),
    'window.navigationData'
  )) as NavigationItem[]
}

/** @deprecated Use {@link alterNavigation} instead. */
export async function writeNavigation(
  app: Application,
  navigation: NavigationItem[]
) {
  await writeGzipJson(
    resolve(app.options.getValue('out'), 'assets', 'navigation.js'),
    navigation,
    'window.navigationData'
  )
}

const navigationTasksStore = new WeakMap<
  Application,
  { alter: AlterNavigationCallback[]; format: FormatNavigationCallback[] }
>()

function getNavigationTasks(app: Application) {
  if (navigationTasksStore.has(app)) {
    return navigationTasksStore.get(app)!
  }

  const navigationTasks: {
    alter: AlterNavigationCallback[]
    format: FormatNavigationCallback[]
  } = { alter: [], format: [] }

  navigationTasksStore.set(app, navigationTasks)

  app.renderer.postRenderAsyncJobs.push(async (event) => {
    const items = (await readGzipJson(
      resolve(app.options.getValue('out'), 'assets', 'navigation.js'),
      'window.navigationData'
    )) as NavigationItem[]

    for (const alter of navigationTasks.alter) {
      await alter(items, { app, event })
    }

    const theme = app.renderer.theme! as DefaultTheme

    const reflections = Object.values(event.project.reflections).filter(
      (reflection) =>
        reflection.url && reflection.name && !reflection.flags.isExternal
    )

    async function formatNavigationItems(items: NavigationItem[]) {
      for (const item of items) {
        const reflectionIndex = reflections.findIndex(
          (reflection) => reflection.url === item.path
        )

        const reflection =
          reflectionIndex === -1 ? undefined : reflections[reflectionIndex]

        if (reflection) {
          if (item.text === undefined) {
            item.text = reflection.name
          }

          if (item.kind === undefined) {
            item.kind = reflection.kind
          }

          if (item.class === undefined) {
            if (
              reflection instanceof DeclarationReflection ||
              reflection instanceof DocumentReflection
            ) {
              item.class = theme.getReflectionClasses(reflection)
            } else {
              item.class = ''
            }

            if (reflection.isDeprecated()) {
              if (item.class) {
                item.class = ' ' + item.class
              }

              item.class = 'deprecated' + item.class
            }
          }
        }

        const dummyItem = {
          path: item.path,
          text: item.text,
          kind: item.kind,
          class: item.class,
        }

        for (const format of navigationTasks.format) {
          await format(dummyItem, { app, event, reflection })
        }

        item.text = dummyItem.text
        item.kind = dummyItem.kind
        item.class = dummyItem.class

        if (item.children && item.children.length) {
          await formatNavigationItems(item.children)
        }
      }
    }

    await formatNavigationItems(items)

    await writeGzipJson(
      resolve(app.options.getValue('out'), 'assets', 'navigation.js'),
      items,
      'window.navigationData'
    )
  })

  return navigationTasks
}

/**
 * @example
 *
 * ```ts
 * import { Application, ReflectionKind } from 'typedoc'
 *
 * export function load(app: Application) {
 *   alterNavigation(app, (items) => {
 *     items.unshift({
 *       path: 'foo.html#bar',
 *       text: 'Foo',
 *       kind: ReflectionKind.Document
 *     })
 *   })
 * }
 * ```
 */
export function alterNavigation(
  app: Application,
  callback: AlterNavigationCallback
) {
  getNavigationTasks(app).alter.push(callback)
}

/**
 * @example
 *
 * ```ts
 * import { Application } from 'typedoc'
 *
 * export function load(app: Application) {
 *   formatNavigation(app, (item) => {
 *     if (!item.class) {
 *       item.class = ''
 *     } else {
 *       item.class += ' '
 *     }
 *
 *     item.class += 'foo-bar'
 *   })
 * }
 * ```
 */
export function formatNavigation(
  app: Application,
  callback: FormatNavigationCallback
) {
  getNavigationTasks(app).format.push(callback)
}

function getCommonDir(app: Application) {
  if (app.options.packageDir) {
    return app.options.packageDir
  }

  const entryPointStrategy = app.options.getValue('entryPointStrategy')

  let entryPoints = app.options.getValue('entryPoints')

  if (entryPointStrategy === EntryPointStrategy.Packages) {
    entryPoints = entryPoints.map((entryPoint) =>
      join(entryPoint, 'package.json').replace(/\\/g, '/')
    )
  }

  return commondir(entryPoints).replace(/\\/g, '/')
}

export function getReadmeFile(app: Application) {
  const readme = app.options.getValue('readme')

  if (readme === 'none') {
    return null
  }

  if (readme) {
    return resolve(readme).replace(/\\/g, '/')
  }

  return (
    escalade(getCommonDir(app), (dir, names) => {
      const readmeFile = names.find((name) => /^readme\.md$/i.test(name))

      if (!readmeFile) {
        return
      }

      return readmeFile
    })?.replace(/\\/g, '/') ?? null
  )
}

export function getPackageFile(app: Application) {
  return (
    escalade(getCommonDir(app), (dir, names) => {
      const packageFile = names.find((name) => /^package\.json$/.test(name))

      if (!packageFile) {
        return
      }

      try {
        // TODO: detect encoding?
        const packageJSON = JSON.parse(
          readFileSync(join(dir, packageFile), { encoding: 'utf-8' })
        )

        if (
          typeof packageJSON !== 'object' ||
          typeof packageJSON.name !== 'string' ||
          (packageJSON.version !== undefined &&
            typeof packageJSON.version !== 'string')
        ) {
          throw 'abort'
        }

        return packageFile
      } catch {
        // ignore
      }
    })?.replace(/\\/g, '/') ?? null
  )
}

export function getPackageJson(app: Application) {
  const packageFile = getPackageFile(app)

  if (!packageFile) {
    return null
  }

  const packageJson = JSON.parse(
    // TODO: detect encoding?
    readFileSync(packageFile, { encoding: 'utf-8' })
  )

  return packageJson
}
