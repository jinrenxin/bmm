'use client'

import {
  actDeleteManyPublicBookmarks,
  actDeleteManyUserBookmarks,
  actDeletePublicBookmark,
  actDeleteUserBookmark,
  actExportPublicBookmarksHtml,
  actExportUserBookmarksHtml,
  actFindPublicBookmarks,
  actFindUserBookmarks,
  actUpdatePublicBookmark,
  actUpdatePublicBookmarkSortOrders,
  actUpdateUserBookmark,
  actUpdateUserBookmarkSortOrders,
} from '@/actions'
import {
  ClientIcon,
  EmptyListPlaceholder,
  Favicon,
  ListPageLayout,
  ReButton,
  ReInput,
} from '@/components'
import MyModal from '@/components/MyModal'
import { findManyBookmarksSchema } from '@/controllers/schemas'
import { usePageUtil } from '@/hooks'
import { runAction } from '@/utils/client'
import { IconNames, PageRoutes } from '@cfg'
import {
  Button,
  ButtonGroup,
  cn,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Link,
  Pagination,
  Select,
  SelectItem,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@heroui/react'
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDebounceFn, useRequest, useSetState, useUpdateEffect } from 'ahooks'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'

const SORTERS = [
  { name: '手动排序', key: 'manual', iconCls: IconNames.SORT },
  { name: '创建时间降序', key: '-createTime', iconCls: IconNames.SORT_DESC },
  { name: '创建时间升序', key: '+createTime', iconCls: IconNames.SORT_ASC },
  { name: '更新时间降序', key: '-updateTime', iconCls: IconNames.SORT_DESC },
  { name: '更新时间升序', key: '+updateTime', iconCls: IconNames.SORT_ASC },
] as const

export type BookmarkListPageProps = {
  tags: SelectTag[]
  totalBookmarks: number
}

const PAGE_SIZES = [20, 50, 100, 300, 500] as const
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0]

export default function BookmarkListPage(props: BookmarkListPageProps) {
  const isUserSpace = usePageUtil().isUserSpace
  const searchParams = useSearchParams()
  const router = useRouter()
  const initPageSize = (() => {
    const raw = Number(searchParams.get('pageSize'))
    if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE
    const val = Math.trunc(raw)
    return (PAGE_SIZES as readonly number[]).includes(val) ? val : DEFAULT_PAGE_SIZE
  })()
  const [state, setState] = useSetState({
    loading: true,
    sorterKey: (searchParams.get('sorterKey') || SORTERS[0].key) as (typeof SORTERS)[number]['key'],
    keyword: searchParams.get('keyword') || '',
    selectedTag: searchParams.get('tag'),
    pageSize: initPageSize,
    sorting: false,
    modals: {
      batchDelete: false,
    },
    pager: {
      page: Number(searchParams.get('page')) || 1,
      // 页码总数
      total: 1,
    },
  })
  const dataRef = useRef({ loadingMutable: true })
  const [selectedKeys, setSelectedKeys] = useState<any>(new Set([]))
  const [exporting, setExporting] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const {
    refresh,
    data: bookmarks = [],
    mutate,
  } = useRequest(
    async () => {
      const input: typeof findManyBookmarksSchema._input = {
        limit: state.pageSize,
        page: state.pager.page,
        keyword: state.keyword,
        sorterKey: state.sorterKey,
        ...(state.selectedTag && { tagIds: state.selectedTag }),
      }
      dataRef.current.loadingMutable && setState({ loading: true })
      const action = isUserSpace ? actFindUserBookmarks : actFindPublicBookmarks
      const res = await runAction(action(findManyBookmarksSchema.parse(input)))
      setState({ loading: false })
      dataRef.current.loadingMutable = true
      if (!res.ok) return []
      setState((state) => ({
        pager: {
          ...state.pager,
          total: Math.max(1, Math.ceil(res.data.total / state.pageSize)),
        },
      }))
      return res.data.list
    },
    {
      ready: isUserSpace !== null,
      refreshDeps: [
        state.keyword,
        state.sorterKey,
        state.pager.page,
        state.selectedTag,
        state.pageSize,
        isUserSpace,
      ],
    }
  )

  // 将状态同步到 URL 查询参数中
  useUpdateEffect(() => {
    const payload: Record<string, string> = {
      page: state.pager.page.toString(),
      sorterKey: state.sorterKey,
      pageSize: state.pageSize.toString(),
    }
    state.selectedTag && (payload.tag = state.selectedTag)
    state.keyword && (payload.keyword = state.keyword)
    router.push('?' + new URLSearchParams(payload).toString())
  }, [state.keyword, state.sorterKey, state.pager.page, state.selectedTag, state.pageSize])

  useUpdateEffect(() => {
    setSelectedKeys(new Set([]))
  }, [state.keyword, state.sorterKey, state.pager.page, state.selectedTag, state.pageSize])

  const selectedIds = useMemo(() => {
    if (selectedKeys === 'all') {
      return bookmarks.map((b) => b.id)
    }
    if (!selectedKeys || typeof selectedKeys[Symbol.iterator] !== 'function') return []
    return Array.from(selectedKeys as Set<any>)
      .map((k) => Number(k))
      .filter((v) => Number.isFinite(v)) as number[]
  }, [bookmarks, selectedKeys])

  const hasSelection = selectedIds.length > 0

  function renderRelatedTags(tagIds: number[] = []) {
    return tagIds
      .map((id) => props.tags.find((item) => item.id === id)?.name)
      .filter(Boolean)
      .join('、')
  }

  const { run: onNameChange } = useDebounceFn(
    (keyword: string) => {
      setState({ keyword, pager: { ...state.pager, page: 1 } })
    },
    { wait: 500, leading: false, trailing: true }
  )

  async function onRemove(item: SelectBookmark) {
    const action = isUserSpace ? actDeleteUserBookmark : actDeletePublicBookmark
    await runAction(action({ id: item.id }), {
      okMsg: '书签已删除',
      onOk: refresh,
    })
  }

  async function onBatchRemove() {
    if (!selectedIds.length || batchDeleting) return
    setBatchDeleting(true)
    const action = isUserSpace ? actDeleteManyUserBookmarks : actDeleteManyPublicBookmarks
    try {
      await runAction(action(selectedIds), {
        okMsg: `已删除 ${selectedIds.length} 个书签`,
        onOk() {
          setSelectedKeys(new Set([]))
          setState({
            modals: { ...state.modals, batchDelete: false },
            pager: { ...state.pager, page: 1 },
          })
          refresh()
        },
      })
    } finally {
      setBatchDeleting(false)
    }
  }

  function onSortingDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = bookmarks.findIndex((b) => b.id === active.id)
    const newIndex = bookmarks.findIndex((b) => b.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    mutate(arrayMove(bookmarks, oldIndex, newIndex))
  }

  async function onSaveSorting() {
    if (!bookmarks.length) return
    const hasFilter = Boolean(state.selectedTag) || Boolean(state.keyword)
    const orders = (() => {
      if (!hasFilter) {
        const max = Math.max(0, ...bookmarks.map((b) => b.sortOrder || 0))
        const base = max + bookmarks.length
        return bookmarks.map((b, idx) => ({ id: b.id, order: base - idx }))
      }

      const oldOrdersSorted = bookmarks.map((b) => b.sortOrder || 0).sort((a, b) => b - a)
      const allSame = oldOrdersSorted.every((v) => v === oldOrdersSorted[0])
      const targetOrders = allSame
        ? bookmarks.map((_, idx) => oldOrdersSorted[0] + (bookmarks.length - idx))
        : oldOrdersSorted

      return bookmarks
        .map((b, idx) => ({ id: b.id, order: targetOrders[idx], oldOrder: b.sortOrder || 0 }))
        .filter((el) => el.order !== el.oldOrder)
        .map((el) => ({ id: el.id, order: el.order }))
    })()
    const action = isUserSpace ? actUpdateUserBookmarkSortOrders : actUpdatePublicBookmarkSortOrders
    await runAction(action(orders), {
      okMsg: '书签排序已更新',
      onOk() {
        setState({ sorting: false })
        refresh()
      },
    })
  }

  function onCancelSorting() {
    setState({ sorting: false })
    refresh()
  }

  function onPageChange(page: number) {
    setState({ pager: { ...state.pager, page } })
  }

  function onChangeIsPinned(item: SelectBookmark, isPinned: boolean) {
    item.isPinned = isPinned
    mutate([...bookmarks])
    dataRef.current.loadingMutable = false
    const action = isUserSpace ? actUpdateUserBookmark : actUpdatePublicBookmark
    runAction(action(item)).then(refresh)
  }

  function toEditPage(item: SelectBookmark) {
    router.push((isUserSpace ? PageRoutes.User : PageRoutes.Admin).bookmarkSlug(item.id))
  }

  async function onExportAll() {
    if (exporting) return
    setExporting(true)
    const action = isUserSpace ? actExportUserBookmarksHtml : actExportPublicBookmarksHtml
    const res = await runAction(action())
    setExporting(false)
    if (!res.ok) return
    const now = new Date()
    const safeTime = now.toISOString().replaceAll(':', '-').slice(0, 19)
    const fileName = `${isUserSpace ? 'user' : 'public'}-bookmarks-${safeTime}.html`
    const blob = new Blob([res.data], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <ListPageLayout>
      <div
        className={cn('grid grid-cols-2 gap-2 sm:grid-cols-5', !props.totalBookmarks && 'hidden')}
      >
        <ReButton
          variant="flat"
          size="sm"
          className="w-20"
          startContent={<span className={cn(IconNames.PLUS, 'text-sm')} />}
          href={(isUserSpace ? PageRoutes.User : PageRoutes.Admin).bookmarkSlug('new')}
        >
          新建
        </ReButton>
        <div className="inline-grid sm:col-end-4">
          <ReInput
            size="sm"
            placeholder="输入名称、地址"
            labelPlacement="outside"
            isClearable
            defaultValue={state.keyword}
            onValueChange={onNameChange}
            onClear={() => onNameChange('')}
          />
        </div>
        <Select
          aria-label="选择标签"
          placeholder="选择标签"
          size="sm"
          selectedKeys={state.selectedTag ? [state.selectedTag] : []}
          onSelectionChange={(val) => {
            setState({ selectedTag: val.currentKey || null, pager: { ...state.pager, page: 1 } })
          }}
        >
          {props.tags.map((tag) => (
            <SelectItem
              key={tag.id}
              startContent={tag.icon ? <ClientIcon icon={tag.icon} /> : null}
            >
              {tag.name}
            </SelectItem>
          ))}
        </Select>
        <Dropdown>
          <DropdownTrigger className="justify-start">
            {(function () {
              const target = SORTERS.find((item) => item.key === state.sorterKey)
              if (!target) return null
              return (
                <Button
                  variant="flat"
                  size="sm"
                  startContent={<span className={cn(target.iconCls, 'text-base')} />}
                >
                  {target.name}
                </Button>
              )
            })()}
          </DropdownTrigger>
          <DropdownMenu
            aria-label="sorter-menu"
            className="min-w-48"
            selectedKeys={[state.sorterKey]}
            selectionMode="single"
            onAction={(key) =>
              setState({ sorterKey: key as any, pager: { ...state.pager, page: 1 } })
            }
          >
            {SORTERS.map((item, idx) => (
              <DropdownItem
                key={item.key}
                startContent={<span className={item.iconCls} />}
                showDivider={idx === 0 || idx === 2}
              >
                {item.name}
              </DropdownItem>
            ))}
          </DropdownMenu>
        </Dropdown>
      </div>

      <ButtonGroup variant="flat" size="sm" className="mt-4">
        <ReButton
          color="danger"
          isDisabled={!hasSelection || state.sorting}
          startContent={<span className={cn(IconNames.TRASH, 'text-sm')} />}
          onClick={() => setState({ modals: { ...state.modals, batchDelete: true } })}
        >
          批量删除
        </ReButton>
        <ReButton
          isDisabled={state.sorting || exporting}
          startContent={<span className="icon-[tabler--download] text-base" />}
          onClick={onExportAll}
        >
          {exporting ? '导出中' : '导出'}
        </ReButton>
        {!state.sorting ? (
          <ReButton
            isDisabled={props.totalBookmarks < 2}
            startContent={<span className={cn(IconNames.SORT, 'text-sm')} />}
            onClick={() => setState({ sorterKey: 'manual', sorting: true })}
          >
            手动排序
          </ReButton>
        ) : (
          <>
            <ReButton
              color="primary"
              startContent={<span className={cn(IconNames.SORT, 'text-sm')} />}
              onClick={onSaveSorting}
              isDisabled={bookmarks.length < 2}
            >
              保存排序
            </ReButton>
            <ReButton variant="flat" onClick={onCancelSorting}>
              退出排序
            </ReButton>
          </>
        )}
      </ButtonGroup>

      {state.sorting ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onSortingDragEnd}
        >
          <SortableContext items={bookmarks}>
            <div className="mt-4 space-y-2">
              {bookmarks.map((b) => (
                <SortableBookmarkRow key={b.id} bookmark={b} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <Table
          aria-label="items table"
          className="mt-4 px-0"
          key={props.tags?.length}
          selectionMode="multiple"
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
        >
          <TableHeader>
            <TableColumn>图标</TableColumn>
            <TableColumn>名称</TableColumn>
            <TableColumn className="max-xs:hidden">地址</TableColumn>
            <TableColumn>关联标签</TableColumn>
            <TableColumn>置顶</TableColumn>
            <TableColumn>操作</TableColumn>
          </TableHeader>
          <TableBody<SelectBookmark>
            items={state.loading ? [] : bookmarks}
            isLoading={state.loading}
            loadingContent={<Spinner className="mt-12" label="Loading..." />}
            emptyContent={<EmptyListPlaceholder target="bookmark" />}
          >
            {(item) => {
              return (
                <TableRow key={item.id}>
                  <TableCell
                    className="flex min-w-8 items-center"
                    style={{ display: 'table-cell' }}
                  >
                    <Favicon src={item.icon} showErrorIconOnFailed showSpinner />
                  </TableCell>
                  <TableCell>
                    <div className="max-w-60 truncate">{item.name}</div>
                  </TableCell>
                  <TableCell className="max-xs:hidden">
                    <Link
                      href={item.url}
                      color="foreground"
                      isExternal
                      size="sm"
                      className="block max-w-52 truncate"
                    >
                      {item.url}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div
                      className="max-xs:max-w-[6rem] max-w-32 truncate text-sm"
                      title={renderRelatedTags(item.relatedTagIds)}
                    >
                      {renderRelatedTags(item.relatedTagIds)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      size="sm"
                      isSelected={item.isPinned || false}
                      onValueChange={(v) => onChangeIsPinned(item, v)}
                    />
                  </TableCell>
                  <TableCell>
                    <ReButton
                      color="danger"
                      variant="light"
                      isIconOnly
                      className="text-2xl"
                      startContent={<span className={IconNames.TRASH} />}
                      popoverContent={
                        <div className="flex max-w-52 flex-col gap-4 p-4">
                          <p>确定删除「{item.name}」？</p>
                          <ReButton color="danger" size="sm" onClick={() => onRemove(item)}>
                            确定
                          </ReButton>
                        </div>
                      }
                    />
                    <ReButton
                      variant="light"
                      className="text-2xl"
                      isIconOnly
                      color="warning"
                      startContent={<span className={IconNames.EDIT} />}
                      onClick={() => toEditPage(item)}
                    />
                  </TableCell>
                </TableRow>
              )
            }}
          </TableBody>
        </Table>
      )}
      {!state.loading && props.totalBookmarks > 0 && (
        <div className="flex items-center justify-center gap-4 pt-4">
          <Pagination
            showShadow
            showControls
            page={state.pager.page}
            total={state.pager.total}
            onChange={onPageChange}
          />
          <Select
            aria-label="分页数量"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([String(state.pageSize)])}
            className="w-[120px]"
            onSelectionChange={(val) => {
              const raw = Number(val.currentKey)
              const next =
                Number.isFinite(raw) && (PAGE_SIZES as readonly number[]).includes(raw)
                  ? raw
                  : DEFAULT_PAGE_SIZE
              setState({ pageSize: next, pager: { ...state.pager, page: 1 } })
            }}
          >
            {PAGE_SIZES.map((size) => (
              <SelectItem key={String(size)} textValue={String(size)}>
                {String(size)}
              </SelectItem>
            ))}
          </Select>
        </div>
      )}
      <MyModal
        isOpen={state.modals.batchDelete}
        title="批量删除书签"
        size="md"
        onClose={() => setState({ modals: { ...state.modals, batchDelete: false } })}
        onOk={onBatchRemove}
        okButtonProps={{
          color: 'danger',
          isDisabled: !hasSelection || batchDeleting,
          isLoading: batchDeleting,
        }}
      >
        <div className="space-y-2 text-sm">
          <div>即将删除 {selectedIds.length} 个书签</div>
          <div className="text-foreground-400">删除后无法恢复</div>
        </div>
      </MyModal>
    </ListPageLayout>
  )
}

function SortableBookmarkRow(props: { bookmark: SelectBookmark }) {
  const { bookmark } = props
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: bookmark.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border-foreground-200 bg-content1 flex-items-center cursor-grab gap-2 rounded border px-2 py-1"
      {...attributes}
      {...listeners}
    >
      <span className={cn(IconNames.SORT, 'text-foreground-400 text-lg')} />
      <Favicon src={bookmark.icon} size={18} showErrorIconOnFailed showSpinner />
      <div className="min-w-0 grow select-none">
        <div className="truncate text-sm">{bookmark.name}</div>
        <div className="text-foreground-400 truncate text-xs">{bookmark.url}</div>
      </div>
    </div>
  )
}
