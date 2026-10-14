import { LoadingIndicator } from 'fluid-lycoris'

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
    <LoadingIndicator label="Loading" size="sm" />
    <LoadingIndicator label="Loading" />
    <LoadingIndicator label="Loading" size="lg" />
  </div>
)

export const WithLabel = () => <LoadingIndicator label="Unpacking the book" showLabel />
