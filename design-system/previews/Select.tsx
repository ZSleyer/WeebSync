import { Select } from '@weebsync/design-system'

export const Protocol = () => (
  <div style={{ maxWidth: 280 }}>
    <Select defaultValue="sftp">
      <option value="sftp">SFTP (SSH)</option>
      <option value="ftps">FTPS (TLS)</option>
      <option value="ftp">FTP</option>
    </Select>
  </div>
)

export const Language = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 280 }}>
    <Select defaultValue="">
      <option value="">Beliebig</option>
      <option value="Ger">Ger</option>
      <option value="Jap">Jap</option>
    </Select>
    <Select defaultValue="Ger" disabled>
      <option value="Ger">Von der Umgebung gesetzt</option>
    </Select>
  </div>
)
