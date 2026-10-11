import { type App, Modal, Setting } from 'obsidian';
import type { Progress } from '../services/vault-run.ts';

// ProgressModal shows a vault run and lets the user stop it. Closing the
// window also stops the run: nothing keeps working out of sight.
export class ProgressModal extends Modal {
  private readonly onCancel: () => void;
  private readonly bar: HTMLProgressElement;
  private readonly status: HTMLElement;
  private readonly detail: HTMLElement;
  private finished = false;

  constructor(app: App, onCancel: () => void) {
    super(app);
    this.onCancel = onCancel;
    this.setTitle('Optimizing images in the vault');
    this.bar = this.contentEl.createEl('progress', { attr: { max: '1', value: '0' } });
    this.bar.style.width = '100%';
    this.status = this.contentEl.createDiv();
    this.detail = this.contentEl.createDiv({ cls: 'setting-item-description' });
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Stop')
      .setWarning()
      .onClick(() => this.close()));
  }

  update(progress: Progress, summary: string): void {
    this.bar.max = Math.max(progress.total, 1);
    this.bar.value = progress.done;
    this.status.setText(`Note ${Math.min(progress.done + 1, progress.total)} of ${progress.total}: ${summary}`);
    this.detail.setText(progress.note);
  }

  finish(): void {
    this.finished = true;
    this.close();
  }

  onClose(): void {
    if (!this.finished) this.onCancel();
  }
}
