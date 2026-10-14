// Set from the last save to the click on "start": the save reports onboarding
// done, and the gate would swap the app in before the closing step showed.
// While it is set, the gate keeps the wizard on screen. A module of its own,
// so the gate can read it without loading the wizard.
export const FINISHING_KEY = 'weebsync.setup.finishing'
