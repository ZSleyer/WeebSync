import {
  BookOpen,
  Captions,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image,
  Music,
} from 'lucide-react'

// extension → icon; anything unknown falls back to the plain file glyph
const BY_EXT: Record<string, typeof File> = {}
const register = (icon: typeof File, exts: string) => exts.split(' ').forEach((e) => (BY_EXT[e] = icon))
register(Film, 'mkv mp4 avi webm mov ts m2ts wmv')
register(Image, 'jpg jpeg png gif webp bmp svg avif')
register(Music, 'mp3 flac aac ogg m4a m4b opus wav mka')
register(Captions, 'ass srt ssa sub vtt')
register(FileArchive, 'zip rar 7z tar gz iso exe')
register(FileText, 'txt nfo md log cue lrc pdf')
register(BookOpen, 'cbz cbr cb7 epub mobi azw3')
register(FileSpreadsheet, 'ods xlsx xls csv')

// FileIcon replaces the old ▸/· glyphs in the browser lists: folders keep the
// accent color, files get a type-specific monochrome icon.
export default function FileIcon({ isDir, name, className }: { isDir: boolean; name: string; className?: string }) {
  const Icon = isDir ? Folder : (BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? File)
  return (
    <Icon aria-hidden size="1em" className={`shrink-0 ${isDir ? 'text-accent' : 'text-t-muted'} ${className ?? ''}`} />
  )
}
