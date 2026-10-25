// The subtitles as a text track of the video, for the browser's own
// picture-in-picture window: Safari (iOS and macOS) and Firefox draw a showing
// track there, libass's canvas stays behind on the page. The track shows only
// while the video floats, so it never stands next to libass on the page. A
// <track> with its own blob, not addTextTrack: a track added that way can
// never be taken off the shared element again.
export function attachPipCues(video: HTMLVideoElement, vtt: string): () => void {
  const el = video.ownerDocument.createElement('track')
  el.kind = 'subtitles'
  const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
  el.src = url
  video.appendChild(el)
  const sync = () => {
    el.track.mode = video.ownerDocument.pictureInPictureElement === video ? 'showing' : 'hidden'
  }
  sync()
  video.addEventListener('enterpictureinpicture', sync)
  video.addEventListener('leavepictureinpicture', sync)
  return () => {
    video.removeEventListener('enterpictureinpicture', sync)
    video.removeEventListener('leavepictureinpicture', sync)
    el.track.mode = 'disabled'
    el.remove()
    URL.revokeObjectURL(url)
  }
}
