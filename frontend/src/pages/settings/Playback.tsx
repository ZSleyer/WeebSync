import HwAccelPanel from './HwAccel'

// How the player gets a video to the browser: the transcoder's hardware. It
// has no form, the panel probes and reports on its own.
export default function Playback() {
  return <HwAccelPanel />
}
