import { db, schema } from '@/db'
import { z } from '@/lib/zod'
import { getPinyin } from '@/utils'
import { DEFAULT_BOOKMARK_PAGESIZE } from '@cfg'
import { and, asc, count, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { createBookmarkFilterByKeyword } from './common'
import PublicTagController from './PublicTag.controller'
import { findManyBookmarksSchema } from './schemas'

const { publicBookmarkToTag, publicBookmarks } = schema

interface TagIdsExt {
  relatedTagIds: TagId[]
}
export type InsertPublicBookmark = Partial<TagIdsExt> & typeof publicBookmarks.$inferInsert
type SelectBookmark = TagIdsExt & typeof publicBookmarks.$inferSelect
export type { SelectBookmark as SelectPublicBookmark }

/**
 * 完全更新 PublicBookmarkToTag 表，使与 bId 关联关联的 tId 全是 tagIds 中的 id
 */
export async function fullSetBookmarkToTag(bId: BookmarkId, tagIds: TagId[]) {
  const task = [
    db
      .insert(publicBookmarkToTag)
      .values(tagIds.map((tId) => ({ bId: bId, tId })))
      .onConflictDoNothing(),
    db
      .delete(publicBookmarkToTag)
      .where(and(eq(publicBookmarkToTag.bId, bId), notInArray(publicBookmarkToTag.tId, tagIds))),
  ]
  await Promise.all(task)
  return
}

const PublicBookmarkController = {
  async insert(bookmark: InsertPublicBookmark) {
    const { relatedTagIds, ...resetBookmark } = bookmark
    // 插入之前先检查当前用户是否有相同网址或名称的记录
    const count = await db.$count(
      publicBookmarks,
      or(eq(publicBookmarks.url, resetBookmark.url), eq(publicBookmarks.name, resetBookmark.name))
    )
    if (count > 0) throw new Error('书签已存在')
    resetBookmark.pinyin ||= getPinyin(resetBookmark.name)
    const rows = await db.insert(publicBookmarks).values(resetBookmark).returning()
    const row = rows[0]
    const id = row.id
    if (relatedTagIds?.length) {
      await fullSetBookmarkToTag(id, relatedTagIds)
    }
    if (resetBookmark.sortOrder === undefined) {
      await db.update(publicBookmarks).set({ sortOrder: id }).where(eq(publicBookmarks.id, id))
      return { ...row, sortOrder: id }
    }
    return row
  },
  async query(bookmark: Pick<SelectBookmark, 'id'>) {
    const res = await db.query.publicBookmarks.findFirst({
      where: eq(publicBookmarks.id, bookmark.id),
      with: { relatedTagIds: true },
    })
    if (!res) throw new Error('书签不存在')
    return {
      ...res,
      relatedTagIds: res.relatedTagIds.map((el) => el.tId),
    }
  },
  async update(bookmark: Partial<SelectBookmark> & Pick<SelectBookmark, 'id'>) {
    const { relatedTagIds, id, ...resetBookmark } = bookmark
    const tasks = []
    if (relatedTagIds?.length) {
      tasks.push(fullSetBookmarkToTag(id, relatedTagIds))
    }
    if (Object.keys(resetBookmark).length) {
      tasks.push(
        db
          .update(publicBookmarks)
          .set({
            ...resetBookmark,
            updatedAt: new Date(),
            pinyin: resetBookmark.name ? getPinyin(resetBookmark.name) : undefined,
          })
          .where(eq(publicBookmarks.id, id))
          .returning()
          .then((res) => res[0])
      )
    }
    const res = await Promise.all(tasks)
    return res.pop()
  },
  async delete(bookmark: Pick<SelectBookmark, 'id'>) {
    const res = await db
      .delete(publicBookmarks)
      .where(eq(publicBookmarks.id, bookmark.id))
      .returning()
    return res
  },
  async deleteMany(ids: BookmarkId[]) {
    if (!ids.length) return { deleted: 0 }
    await db.delete(publicBookmarks).where(inArray(publicBookmarks.id, ids))
    return { deleted: ids.length }
  },
  async sort(orders: { id: BookmarkId; order: number }[]) {
    const tasks = orders.map((el) =>
      db.update(publicBookmarks).set({ sortOrder: el.order }).where(eq(publicBookmarks.id, el.id))
    )
    await Promise.all(tasks)
  },
  /**
   * 高级搜索书签列表
   */
  async findMany(query?: z.output<typeof findManyBookmarksSchema>) {
    query ||= findManyBookmarksSchema.parse({})
    const { keyword, tagIds = [], tagNames, page, limit, sorterKey } = query
    const getFilters = async () => {
      const filters = []
      if (keyword) {
        filters.push(createBookmarkFilterByKeyword(publicBookmarks, keyword))
      }
      if (tagNames?.length) {
        const tags = await PublicTagController.getAll()
        for (const name of tagNames) {
          const tag = tags.find((el) => el.name === name)
          tag && tagIds.push(tag.id)
        }
      }
      if (tagIds.length) {
        const findTargetBIds = db
          .select({ bId: publicBookmarkToTag.bId })
          .from(publicBookmarkToTag)
          .where(inArray(publicBookmarkToTag.tId, tagIds))
          .groupBy(publicBookmarkToTag.bId)
          .having(sql`COUNT(DISTINCT ${publicBookmarkToTag.tId}) = ${tagIds.length}`)
        filters.push(inArray(publicBookmarks.id, findTargetBIds))
      }
      return filters.length ? and(...filters) : undefined
    }
    const filters = await getFilters()
    const [list, [{ total }]] = await Promise.all([
      await db.query.publicBookmarks.findMany({
        where: filters,
        with: { relatedTagIds: true },
        limit,
        offset: (page - 1) * limit,
        orderBy: (() => {
          if (sorterKey === 'manual') {
            return [desc(publicBookmarks.sortOrder), desc(publicBookmarks.updatedAt)]
          }
          const sort = sorterKey.startsWith('-') ? desc : asc
          const field = sorterKey.includes('update')
            ? publicBookmarks.updatedAt
            : sorterKey.includes('create')
              ? publicBookmarks.createdAt
              : null
          return field ? [sort(field)] : undefined
        })(),
      }),
      db.select({ total: count() }).from(publicBookmarks).where(filters),
    ])

    return {
      total,
      hasMore: total > page * limit,
      list: list.map((item) => ({
        ...item,
        relatedTagIds: item.relatedTagIds.map((el) => el.tId),
      })),
    }
  },
  async random() {
    const list = await db.query.publicBookmarks.findMany({
      with: { relatedTagIds: true },
      orderBy: sql`RANDOM()`,
      limit: DEFAULT_BOOKMARK_PAGESIZE,
    })
    return {
      list: list.map((item) => ({
        ...item,
        relatedTagIds: item.relatedTagIds.map((el) => el.tId),
      })),
    }
  },
  /** 获取所有书签数量 */
  async total() {
    return await db.$count(publicBookmarks)
  },
  /** 获取最近更新的 $DEFAULT_BOOKMARK_PAGESIZE 个书签 */
  async recent() {
    const res = await db.query.publicBookmarks.findMany({
      orderBy: [desc(publicBookmarks.sortOrder), desc(publicBookmarks.updatedAt)],
      with: { relatedTagIds: true },
      limit: DEFAULT_BOOKMARK_PAGESIZE,
    })
    return {
      list: res.map((item) => ({
        ...item,
        relatedTagIds: item.relatedTagIds.map((el) => el.tId),
      })),
    }
  },
  /** 根据关键词搜索书签 */
  async search(keyword: string) {
    const res = await db.query.publicBookmarks.findMany({
      where: createBookmarkFilterByKeyword(publicBookmarks, keyword),
      with: { relatedTagIds: true },
      orderBy: [desc(publicBookmarks.sortOrder), desc(publicBookmarks.updatedAt)],
      limit: 100,
    })
    return {
      list: res.map((item) => ({
        ...item,
        relatedTagIds: item.relatedTagIds.map((el) => el.tId),
      })),
    }
  },
  async exportHtml() {
    const [tags, list] = await Promise.all([
      PublicTagController.getAll(),
      db.query.publicBookmarks.findMany({
        columns: { name: true, url: true, createdAt: true, updatedAt: true },
        with: { relatedTagIds: { columns: { tId: true } } },
        orderBy: [desc(publicBookmarks.sortOrder), desc(publicBookmarks.updatedAt)],
      }),
    ])

    const tagIdToName = new Map(tags.map((t) => [t.id, t.name] as const))
    const tagIdToBookmarks = new Map<TagId, BookmarkHtmlItem[]>()
    const untagged: BookmarkHtmlItem[] = []

    for (const b of list) {
      const item: BookmarkHtmlItem = {
        name: b.name,
        url: b.url,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      }

      const tagIds = b.relatedTagIds.map((el) => el.tId).filter((id) => Number.isFinite(id))
      if (!tagIds.length) {
        untagged.push(item)
        continue
      }

      for (const tId of tagIds) {
        if (!tagIdToName.has(tId)) continue
        const arr = tagIdToBookmarks.get(tId)
        if (arr) {
          arr.push(item)
        } else {
          tagIdToBookmarks.set(tId, [item])
        }
      }
    }

    const folders: BookmarkHtmlFolder[] = []
    for (const t of tags) {
      const bookmarks = tagIdToBookmarks.get(t.id)
      if (!bookmarks?.length) continue
      folders.push({ name: t.name, bookmarks })
    }
    if (untagged.length) {
      folders.push({ name: '未分类', bookmarks: untagged })
    }

    return buildBookmarkHtml({
      title: 'bmm public bookmarks',
      folderName: 'bmm-export',
      folders,
    })
  },
}

export default PublicBookmarkController

type BookmarkHtmlItem = {
  name: string
  url: string
  createdAt?: unknown
  updatedAt?: unknown
}

type BookmarkHtmlFolder = {
  name: string
  bookmarks: BookmarkHtmlItem[]
}

function buildBookmarkHtml(input: {
  title: string
  folderName: string
  folders: BookmarkHtmlFolder[]
}) {
  const escapeHtml = (val: string) =>
    val
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')

  const toUnixSeconds = (val: unknown) => {
    if (val instanceof Date) return Math.floor(val.getTime() / 1000)
    if (typeof val === 'number') return val > 10_000_000_000 ? Math.floor(val / 1000) : val
    if (typeof val === 'string') {
      const t = Date.parse(val)
      if (Number.isFinite(t)) return Math.floor(t / 1000)
    }
    return Math.floor(Date.now() / 1000)
  }

  const title = escapeHtml(input.title)
  const folderName = escapeHtml(input.folderName)
  const folderAddDate = Math.floor(Date.now() / 1000)

  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${title}</TITLE>`,
    `<H1>${title}</H1>`,
    '<DL><p>',
    `  <DT><H3 ADD_DATE="${folderAddDate}">${folderName}</H3>`,
    '  <DL><p>',
  ]

  for (const folder of input.folders) {
    const safeFolderName = escapeHtml(folder.name)
    lines.push(`    <DT><H3 ADD_DATE="${folderAddDate}">${safeFolderName}</H3>`)
    lines.push('    <DL><p>')
    for (const b of folder.bookmarks) {
      const name = escapeHtml(b.name || b.url)
      const url = escapeHtml(b.url)
      const addDate = toUnixSeconds(b.createdAt ?? b.updatedAt)
      lines.push(`      <DT><A HREF="${url}" ADD_DATE="${addDate}">${name}</A>`)
    }
    lines.push('    </DL><p>')
  }

  lines.push('  </DL><p>', '</DL><p>')

  return lines.join('\n')
}
