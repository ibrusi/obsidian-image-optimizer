const { Plugin, PluginSettingTab, Setting, Notice, TFile } = require('obsidian');
const { execFile } = require('child_process');
const path = require('path');

const DEFAULT_SETTINGS = {
    binaryPath: 'obsidian-img-opt',
    quality: 20,
    gifMode: 'auto',
    gifLossy: 80,
    attachedDir: 'attached',
    backupDir: '.originals_backup',
    keepBackup: true,
    optimizeLocal: false,
    linkFormat: 'markdown'
};

module.exports = class ImageOptimizerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        // Ribbon Icon (left sidebar)
        this.addRibbonIcon('image-down', 'Optimize Images in Note (Go)', async () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || activeFile.extension !== 'md') {
                new Notice('Please open a markdown note first.');
                return;
            }
            await this.optimizeFile(activeFile);
        });

        // Command: Current file
        this.addCommand({
            id: 'optimize-current-file',
            name: 'Optimize images in current note',
            checkCallback: (checking) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'md') {
                    if (!checking) {
                        this.optimizeFile(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        // Command: Entire vault
        this.addCommand({
            id: 'optimize-entire-vault',
            name: 'Optimize images in entire vault',
            callback: () => {
                this.optimizeVault();
            }
        });

        // Settings tab
        this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getVaultBasePath() {
        if (this.app.vault.adapter && this.app.vault.adapter.basePath) {
            return this.app.vault.adapter.basePath;
        }
        return '';
    }

    async optimizeFile(file) {
        const vaultPath = this.getVaultBasePath();
        const fullFilePath = path.join(vaultPath, file.path);

        new Notice(`⏳ Optimizing images in "${file.basename}"...`, 3000);

        const args = [
            '--file', fullFilePath,
            '--quality', String(this.settings.quality),
            '--gif-mode', this.settings.gifMode,
            '--gif-lossy', String(this.settings.gifLossy),
            '--attached-dir', this.settings.attachedDir,
            '--backup-dir', this.settings.backupDir,
            '--link-format', this.settings.linkFormat
        ];

        if (this.settings.keepBackup) {
            args.push('--keep-backup');
        }
        if (this.settings.optimizeLocal) {
            args.push('--optimize-local');
        }

        this.runBinary(args, `Note "${file.basename}"`);
    }

    async optimizeVault() {
        const vaultPath = this.getVaultBasePath();
        if (!vaultPath) {
            new Notice('Unable to resolve vault directory path.');
            return;
        }

        new Notice('⏳ Scanning and optimizing images in entire vault...', 5000);

        const args = [
            '--vault', vaultPath,
            '--quality', String(this.settings.quality),
            '--gif-mode', this.settings.gifMode,
            '--gif-lossy', String(this.settings.gifLossy),
            '--attached-dir', this.settings.attachedDir,
            '--backup-dir', this.settings.backupDir,
            '--link-format', this.settings.linkFormat
        ];

        if (this.settings.keepBackup) {
            args.push('--keep-backup');
        }
        if (this.settings.optimizeLocal) {
            args.push('--optimize-local');
        }

        this.runBinary(args, 'Vault');
    }

    runBinary(args, scopeName) {
        const bin = this.settings.binaryPath.trim() || 'obsidian-img-opt';

        execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error('[ImageOptimizer Error]', error, stderr);
                new Notice(`❌ Optimization error: ${error.message}\nMake sure "${bin}" is in PATH or specify full path in settings.`, 8000);
                return;
            }

            console.log('[ImageOptimizer Output]\n' + stdout);

            // Extract savings percentage or summary line if present
            const matchSavings = stdout.match(/Total space saved:\s+(.+)/);
            if (matchSavings) {
                new Notice(`✅ ${scopeName} optimized! Saved: ${matchSavings[1]}`, 6000);
            } else if (stdout.includes('No compressible images') || stdout.includes('No remote images')) {
                new Notice(`ℹ️ ${scopeName}: No images required optimization.`, 4000);
            } else {
                new Notice(`✅ ${scopeName} image optimization complete!`, 4000);
            }
        });
    }
};

class ImageOptimizerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Image Optimizer (Go) Settings' });

        new Setting(containerEl)
            .setName('Go Binary Path')
            .setDesc('Absolute path or command name for obsidian-img-opt executable.')
            .addText(text => text
                .setPlaceholder('obsidian-img-opt')
                .setValue(this.plugin.settings.binaryPath)
                .onChange(async (val) => {
                    this.plugin.settings.binaryPath = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('WebP Quality (Default: 20%)')
            .setDesc('Compression quality (1-100). Recommended is 20: minimal size where text in diagrams and screenshots remains sharp.')
            .addSlider(slider => slider
                .setLimits(1, 100, 1)
                .setValue(this.plugin.settings.quality)
                .setDynamicTooltip()
                .onChange(async (val) => {
                    this.plugin.settings.quality = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('GIF Processing Mode')
            .setDesc('Strategy for GIFs. "auto" / "webp" converts to animated WebP (supported natively in Obsidian). "optimize" runs gifsicle/ffmpeg lossy compression.')
            .addDropdown(drop => drop
                .addOption('auto', 'Auto (Animated WebP with fallback)')
                .addOption('webp', 'WebP (Animated WebP)')
                .addOption('optimize', 'Optimize GIF (Gifsicle / Palette)')
                .addOption('keep', 'Keep original GIF')
                .setValue(this.plugin.settings.gifMode)
                .onChange(async (val) => {
                    this.plugin.settings.gifMode = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Attached Folder Name')
            .setDesc('Folder created alongside notes where downloaded images are saved.')
            .addText(text => text
                .setPlaceholder('attached')
                .setValue(this.plugin.settings.attachedDir)
                .onChange(async (val) => {
                    this.plugin.settings.attachedDir = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Keep Original Backups')
            .setDesc('Preserve uncompressed original images in .originals_backup inside the attachments folder.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.keepBackup)
                .onChange(async (val) => {
                    this.plugin.settings.keepBackup = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Optimize Existing Local Images')
            .setDesc('Also convert existing local JPG/PNG/GIF files in the vault to WebP (only if new size is smaller).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.optimizeLocal)
                .onChange(async (val) => {
                    this.plugin.settings.optimizeLocal = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Markdown Link Format')
            .setDesc('Format to replace remote links with: standard Markdown ![](attached/pic.webp) or Obsidian Wikilink ![[attached/pic.webp]].')
            .addDropdown(drop => drop
                .addOption('markdown', 'Markdown: ![alt](attached/...)')
                .addOption('wikilink', 'Wikilink: ![[attached/...]]')
                .setValue(this.plugin.settings.linkFormat)
                .onChange(async (val) => {
                    this.plugin.settings.linkFormat = val;
                    await this.plugin.saveSettings();
                }));
    }
}
