import { pool, RowDataPacket } from '../config/database';
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
  `CREATE TABLE IF NOT EXISTS Users (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    Username VARCHAR(255) NOT NULL,
    Email VARCHAR(255) NOT NULL,
    PasswordHash VARCHAR(255) NULL,
    PmUserId INT NULL,
    IsAdmin TINYINT NOT NULL DEFAULT 0,
    IsActive TINYINT NOT NULL DEFAULT 1,
    SessionVersion INT NOT NULL DEFAULT 0,
    LastLoginAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_username (Username),
    UNIQUE KEY uq_users_email (Email),
    UNIQUE KEY uq_users_pm (PmUserId)
  )`,
  `CREATE TABLE IF NOT EXISTS AppSettings (
    SettingKey VARCHAR(64) NOT NULL PRIMARY KEY,
    SettingValue TEXT NULL,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS PasswordResetTokens (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    UserId INT NOT NULL,
    TokenHash VARCHAR(64) NOT NULL,
    ExpiresAt DATETIME NOT NULL,
    UsedAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_prt_hash (TokenHash),
    KEY idx_prt_user (UserId),
    CONSTRAINT fk_prt_user FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
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
    Icon VARCHAR(64) NULL,
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
    UserId INT NOT NULL PRIMARY KEY,
    AccessTokenEnc TEXT NOT NULL,
    ExpiresAt DATETIME NOT NULL,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_sso_user FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
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
  `CREATE TABLE IF NOT EXISTS NoteTemplates (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    Slug VARCHAR(64) NULL,
    Label VARCHAR(255) NOT NULL,
    Description VARCHAR(512) NULL,
    BodyMarkdown MEDIUMTEXT NOT NULL,
    Kind ENUM('system', 'global', 'user') NOT NULL,
    OwnerUserId INT NULL,
    ShareStatus ENUM('private', 'pending', 'published') NOT NULL DEFAULT 'private',
    SortOrder INT NOT NULL DEFAULT 0,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_note_template_slug (Slug),
    KEY idx_note_template_kind_share (Kind, ShareStatus),
    KEY idx_note_template_owner (OwnerUserId),
    CONSTRAINT fk_note_template_owner FOREIGN KEY (OwnerUserId) REFERENCES Users(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ExportTemplates (
    Id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    Label VARCHAR(255) NOT NULL,
    Description VARCHAR(512) NULL,
    OriginalName VARCHAR(512) NOT NULL,
    StorageName VARCHAR(128) NOT NULL,
    MimeType VARCHAR(128) NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    SizeBytes INT NOT NULL,
    UploadedByUserId INT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_export_template_storage (StorageName),
    KEY idx_export_template_label (Label),
    CONSTRAINT fk_export_template_uploader FOREIGN KEY (UploadedByUserId) REFERENCES Users(Id) ON DELETE SET NULL
  )`,
];

const ALTERS = [
  'ALTER TABLE Notes ADD COLUMN DeletedAt DATETIME NULL',
  'ALTER TABLE Notes ADD KEY idx_note_deleted (VaultId, DeletedAt)',
  'ALTER TABLE Notes ADD COLUMN Icon VARCHAR(64) NULL',
  'ALTER TABLE Users ADD COLUMN SessionVersion INT NOT NULL DEFAULT 0',
];

/** Legacy SsoTokens used PmUserId PK — migrate rows into UserId-keyed table after Users exist. */
async function migrateSsoTokensIfNeeded(): Promise<void> {
  const [cols] = await pool.execute<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SsoTokens'`
  );
  const names = new Set(cols.map((c) => String(c.name)));
  if (!names.has('PmUserId') || names.has('UserId')) return;

  logger.info('Migrating SsoTokens from PmUserId to UserId');
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS SsoTokens_new (
      UserId INT NOT NULL PRIMARY KEY,
      AccessTokenEnc TEXT NOT NULL,
      ExpiresAt DATETIME NOT NULL,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    INSERT IGNORE INTO SsoTokens_new (UserId, AccessTokenEnc, ExpiresAt, UpdatedAt)
    SELECT u.Id, s.AccessTokenEnc, s.ExpiresAt, s.UpdatedAt
    FROM SsoTokens s
    INNER JOIN Users u ON u.PmUserId = s.PmUserId OR u.Id = s.PmUserId
  `);
  await pool.execute('DROP TABLE SsoTokens');
  await pool.execute('RENAME TABLE SsoTokens_new TO SsoTokens');
  try {
    await pool.execute(
      'ALTER TABLE SsoTokens ADD CONSTRAINT fk_sso_user FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE'
    );
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== 'ER_DUP_KEYNAME' && code !== 'ER_FK_DUP_NAME') {
      logger.warn('SsoTokens FK add skipped', { error });
    }
  }
}

async function migrateUserProfilesToUsers(): Promise<void> {
  const [countRows] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM Users');
  if (Number(countRows[0]?.c || 0) > 0) return;

  const [profiles] = await pool.execute<RowDataPacket[]>(
    'SELECT PmUserId, Username, Email, LastLoginAt, CreatedAt, UpdatedAt FROM UserProfiles'
  );
  if (!profiles.length) return;

  logger.info('Migrating UserProfiles into Users', { count: profiles.length });
  for (const p of profiles) {
    await pool.execute(
      `INSERT INTO Users (Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, LastLoginAt, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, NULL, ?, 0, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE Email = VALUES(Email), Username = VALUES(Username)`,
      [
        p.PmUserId,
        p.Username,
        String(p.Email || '').toLowerCase(),
        p.PmUserId,
        p.LastLoginAt,
        p.CreatedAt,
        p.UpdatedAt,
      ]
    );
  }
  const [admins] = await pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM Users WHERE IsAdmin = 1'
  );
  if (Number(admins[0]?.c || 0) === 0) {
    const [first] = await pool.execute<RowDataPacket[]>(
      'SELECT Id FROM Users ORDER BY Id ASC LIMIT 1'
    );
    if (first[0]) {
      await pool.execute('UPDATE Users SET IsAdmin = 1 WHERE Id = ?', [first[0].Id]);
    }
  }
}

async function seedDefaultAppSettings(): Promise<void> {
  const defaults: Record<string, string> = {
    siteName: 'PM Synapse',
    allowPublicWikiDirectory: 'true',
    allowPublicRegistration: 'true',
    allowSsoLogin: 'true',
    minPasswordLength: '8',
    pmIntegrationEnabled: 'true',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.execute(
      `INSERT IGNORE INTO AppSettings (SettingKey, SettingValue) VALUES (?, ?)`,
      [key, value]
    );
  }
}

/** Seed built-in templates; INSERT IGNORE so new code templates appear without overwriting edits. */
async function seedSystemNoteTemplates(): Promise<void> {
  const { SYSTEM_NOTE_TEMPLATE_SEEDS } = await import('./systemNoteTemplates');
  for (const t of SYSTEM_NOTE_TEMPLATE_SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO NoteTemplates
        (Slug, Label, Description, BodyMarkdown, Kind, OwnerUserId, ShareStatus, SortOrder)
       VALUES (?, ?, ?, ?, 'system', NULL, 'published', ?)`,
      [t.slug, t.label, t.description, t.bodyTemplate, t.sortOrder]
    );
  }
}

export async function ensureSchema(): Promise<void> {
  for (const sql of STATEMENTS) {
    await pool.execute(sql);
  }
  for (const sql of ALTERS) {
    try {
      await pool.execute(sql);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== 'ER_DUP_FIELDNAME' && code !== 'ER_DUP_KEYNAME') {
        logger.warn('Schema alter skipped or failed', { sql, error });
      }
    }
  }

  await migrateUserProfilesToUsers();
  await migrateSsoTokensIfNeeded();
  await seedDefaultAppSettings();
  await seedSystemNoteTemplates();

  logger.info('PM Synapse schema ready');
}
