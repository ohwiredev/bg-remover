import { useEffect, useRef, useState } from 'react'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/bmp,image/gif'

function firstImage(files: FileList | null | undefined): File | null {
  if (!files) return null
  return Array.from(files).find((f) => f.type.startsWith('image/')) ?? null
}

/**
 * Page-wide image input: drop anywhere, paste anywhere, or open the file picker.
 * Render `input` somewhere in the tree for the picker to work.
 */
export function useImageInput(onFile: (file: File) => void) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    // dragenter/leave fire for every child element; count them to know when the drag really left.
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = firstImage(e.dataTransfer?.files)
      if (file) onFile(file)
    }
    const onPaste = (e: ClipboardEvent) => {
      const file = firstImage(e.clipboardData?.files)
      if (file) onFile(file)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [onFile])

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      className="hidden"
      onChange={(e) => {
        const file = firstImage(e.target.files)
        if (file) onFile(file)
        e.target.value = ''
      }}
    />
  )

  return { dragging, openPicker: () => inputRef.current?.click(), input }
}
