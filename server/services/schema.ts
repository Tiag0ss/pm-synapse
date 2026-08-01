import { pool } from '../config/database';
import logger from '../utils/logger';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS UserProfiles (
    PmUserId INT NOT NULL PRIMARY KEY,
    Username VARCHAR(255) NOT NULL,
    Email VARCHAR(255) NOT NULL,
    LastLoginAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS Vaults (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    OwnerPmUserId INT NOT NULL,
    Name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    Description TEXT NULL,
    DefaultVisibility VARCHAR(32) NOT NULL DEFAULT 'private',
    AllowPublicPages TINYINT NOT NULL DEFAULT 0,
    PmOrganizationId INT NULL,
    PmProjectId INT NULL,
    PmProjectLinkedAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_vault_owner_slug (OwnerPmUserId, slug),
    KEY idx_vault_owner (OwnerPmUserId)
  )`,
  `CREATE TABLE IF NOT EXISTS Notes (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    VaultId INT NOT NULL,
    Path VARCHAR(1024) NOT NULL,
    Title VARCHAR(512) NOT NULL,
    BodyMarkdown MEDIUMTEXT NOT NULL,
    FrontmatterJson TEXT NULL,
    Visibility VARCHAR(32) NULL,
    AliasesJson TEXT NULL,
    PmTaskId INT NULL,
    PmProjectId INT NULL,
    PmTaskLinkedAt DATETIME NULL,
    DeletedAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_note_vault_path (VaultId, Path(255)),
    KEY idx_note_vault (VaultId),
    KEY idx_note_title (VaultId, Title(191)),
    KEY idx_note_deleted (VaultId, DeletedAt),
    CONSTRAINT fk_notes_vault FOREIGN KEY (VaultId) REFERENCES Vaults(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS NoteRevisions (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    NoteId INT NOT NULL,
    RevisionNumber INT NOT NULL,
    Title VARCHAR(512) NOT NULL,
    Path VARCHAR(1024) NOT NULL,
    BodyMarkdown MEDIUMTEXT NOT NULL,
    FrontmatterJson TEXT NULL,
    Visibility VARCHAR(32) NULL,
    CreatedByPmUserId INT NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_note_rev (NoteId, RevisionNumber),
    KEY idx_rev_note (NoteId),
    CONSTRAINT fk_revisions_note FOREIGN KEY (NoteId) REFERENCES Notes(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS NoteLinks (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    FromNoteId INT NOT NULL,
    ToNoteId INT NOT NULL,
    Kind VARCHAR(32) NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_link (FromNoteId, ToNoteId, Kind),
    KEY idx_link_from (FromNoteId),
    KEY idx_link_to (ToNoteId),
    CONSTRAINT fk_link_from FOREIGN KEY (FromNoteId) REFERENCES Notes(Id) ON DELETE CASCADE,
    CONSTRAINT fk_link_to FOREIGN KEY (ToNoteId) REFERENCES Notes(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS NoteTags (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    NoteId INT NOT NULL,
    Tag VARCHAR(128) NOT NULL,
    UNIQUE KEY uq_note_tag (NoteId, Tag),
    KEY idx_tag (Tag),
    CONSTRAINT fk_tags_note FOREIGN KEY (NoteId) REFERENCES Notes(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS SsoTokens (
    PmUserId INT NOT NULL PRIMARY KEY,
    AccessTokenEnc TEXT NOT NULL,
    ExpiresAt DATETIME NOT NULL,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS NoteCheckboxTasks (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    NoteId INT NOT NULL,
    MarkerId VARCHAR(64) NOT NULL,
    Text VARCHAR(512) NOT NULL,
    Checked TINYINT NOT NULL DEFAULT 0,
    PmTaskId INT NULL,
    PmProjectId INT NULL,
    PmTaskLinkedAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_note_marker (NoteId, MarkerId),
    KEY idx_cb_note (NoteId),
    KEY idx_cb_task (PmTaskId),
    CONSTRAINT fk_cb_note FOREIGN KEY (NoteId) REFERENCES Notes(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS VaultMedia (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    VaultId INT NOT NULL,
    StorageName VARCHAR(128) NOT NULL,
    OriginalName VARCHAR(512) NULL,
    MimeType VARCHAR(128) NOT NULL,
    SizeBytes INT NOT NULL,
    CreatedByPmUserId INT NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_media_storage (VaultId, StorageName),
    KEY idx_media_vault (VaultId),
    CONSTRAINT fk_media_vault FOREIGN KEY (VaultId) REFERENCES Vaults(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS VaultMembers (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    VaultId INT NOT NULL,
    PmUserId INT NOT NULL,
    Role VARCHAR(16) NOT NULL,
    InvitedByPmUserId INT NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_vault_member (VaultId, PmUserId),
    KEY idx_vm_user (PmUserId),
    CONSTRAINT fk_vm_vault FOREIGN KEY (VaultId) REFERENCES Vaults(Id) ON DELETE CASCADE
  )`,
];

const ALTERS = [
  'ALTER TABLE Notes ADD COLUMN DeletedAt DATETIME NULL',
  'ALTER TABLE Notes ADD KEY idx_note_deleted (VaultId, DeletedAt)',
];

export async function ensureSchema(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.execute(sql);
  }
  for (const sql of ALTERS) {
    try {
      await pool.execute(sql);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // Duplicate column / key name — already migrated
      if (code !== 'ER_DUP_FIELDNAME' && code !== 'ER_DUP_KEYNAME') {
        logger.warn('Schema alter skipped or failed', { sql, error });
      }
    }
  }
  logger.info('PM Synapse schema ready');
}
