import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, FS_ERROR_CODES, type ContainerIdentity, type SystemStatus } from '../api'

// isFsErrorCode says whether the backend classified a failure well enough for
// FsErrorNote to explain it. Anything else keeps its raw text.
export function isFsErrorCode(code?: string): code is string {
  return !!code && FS_ERROR_CODES.includes(code)
}

// useContainerIdentity fetches the UID/GID the container writes as. /api/status
// is admin-gated, so a non-admin session gets nothing back and the message
// simply leaves that sentence out instead of inventing an identity. Fetched
// once and kept, since it cannot change while the process runs.
function useContainerIdentity(): ContainerIdentity | undefined {
  const { data } = useQuery<SystemStatus>({
    queryKey: ['status', 'container'],
    queryFn: () => api.get('/api/status'),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return data?.container
}

// FsErrorNote spells out a filesystem failure: what went wrong, on which
// directory, and the one change that fixes it. It replaces a truncated error
// string whose full text lived in a title attribute - which a phone has no way
// to show at all, so the failure that stopped every download read as noise.
//
// dir is the directory the write was aimed at, never the file: permissions,
// mount flags and free space are all properties of the directory.
//
// The text wraps instead of truncating (the path is the half the user needs)
// and the whole note reflows down to a 320px viewport.
export function FsErrorNote({ code, dir, className = '' }: { code: string; dir: string; className?: string }) {
  const { t } = useTranslation()
  const identity = useContainerIdentity()
  // only a permission failure is about who we are; a full or read-only mount
  // would be just as broken for any other user
  const naming = code === 'permission_denied' && identity
  return (
    <div className={`flex gap-2 border border-err/40 px-3 py-2 text-xs ${className}`}>
      <TriangleAlert aria-hidden size="1em" className="mt-0.5 shrink-0 text-err" />
      <p className="min-w-0 wrap-break-word">
        <span className="text-err">{t(`fsError.${code}.what`, { path: dir || '/' })}</span>{' '}
        <span className="text-t-secondary">
          {naming && <>{t('fsError.identity', { uid: identity.uid, gid: identity.gid })} </>}
          {t(`fsError.${code}.fix`)}
        </span>
      </p>
    </div>
  )
}
