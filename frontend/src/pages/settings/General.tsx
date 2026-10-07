import Look from './Look'

// Theme, accent, language and motion: instant controls, no save button. About
// is a section of its own at the foot of the menu.
export default function General() {
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Look />
    </div>
  )
}
