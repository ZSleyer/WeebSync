import Look from './Look'
import About from './About'

// Look and About on one short screen: both are instant controls and read-only
// facts, neither has a save button. /settings/about still lands on its panel.
export default function General() {
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Look />
      <div id="about">
        <About />
      </div>
    </div>
  )
}
