import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

type State = 'idle' | 'selected' | 'converting' | 'done';

@Component({
  selector: 'app-convert-component',
  standalone: true,
  imports: [],
  templateUrl: './convert.component.html',
  styleUrl: './convert.component.scss',
})
export class ConvertComponent {
  private http = inject(HttpClient);

  state = signal<State>('idle');
  isDragging = signal(false);

  selectedFile: File | null = null;
  selectedFormat = signal<string | null>(null);
  targetFormats = signal<string[]>([]);
  errorMessage = signal('');
  outputName = signal('');

  private downloadUrl: string | null = null;

  // --- drag & drop / file picker ---

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      this.chooseFile(file);
    }
  }

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.chooseFile(file);
    }
  }

  // --- flow ---

  chooseFile(file: File) {
    this.revokeDownload();
    this.selectedFile = file;
    this.selectedFormat.set(null);
    this.errorMessage.set('');
    this.outputName.set('');

    // Ask the server which formats this file can convert to.
    this.http
      .get<{ kind: string; targets: string[] }>('/api/formats', {
        params: { filename: file.name },
      })
      .subscribe({
        next: (res) => {
          console.log('[formats]', file.name, '->', res);

          if (res.kind === 'unsupported' || res.targets.length === 0) {
            this.selectedFile = null;
            this.targetFormats.set([]);
            this.state.set('idle');
            this.errorMessage.set(
              "That file type isn't supported yet. Try an image (JPG, PNG, WebP, GIF, TIFF, AVIF) or audio (MP3, WAV, FLAC, OGG, M4A).",
            );
            return;
          }

          this.targetFormats.set(res.targets.map((t) => t.toUpperCase()));
          this.state.set('selected');
        },
        error: (err) => {
          console.error('[formats] failed', err);
          this.selectedFile = null;
          this.state.set('idle');
          this.errorMessage.set('Could not reach the server.');
        },
      });
  }

  pickFormat(format: string) {
    this.selectedFormat.set(format);
  }

  removeFile() {
    this.reset();
  }

  convert() {
    const file = this.selectedFile;
    const format = this.selectedFormat();
    if (!file || !format) {
      return;
    }

    const form = new FormData();
    form.append('file', file, file.name);
    form.append('format', format.toLowerCase());

    this.state.set('converting');
    this.errorMessage.set('');
    console.log('[convert] sending', file.name, '->', format);

    this.http.post('/api/convert', form, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.revokeDownload();
        this.downloadUrl = URL.createObjectURL(blob);

        const base = file.name.replace(/\.[^.]+$/, '') || 'converted';
        this.outputName.set(`${base}.${format.toLowerCase()}`);
        console.log('[convert] done', this.outputName(), blob.size, 'bytes');
        this.state.set('done');
      },
      error: async (err) => {
        let message = 'Conversion failed';
        try {
          const text = await (err.error as Blob).text();
          message = JSON.parse(text).error ?? message;
        } catch {
          /* keep default */
        }
        console.error('[convert] failed', err.status, message);
        this.errorMessage.set(message);
        this.state.set('selected');
      },
    });
  }

  download() {
    if (!this.downloadUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = this.downloadUrl;
    link.download = this.outputName();
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  reset() {
    this.revokeDownload();
    this.selectedFile = null;
    this.selectedFormat.set(null);
    this.targetFormats.set([]);
    this.errorMessage.set('');
    this.outputName.set('');
    this.state.set('idle');
  }

  private revokeDownload() {
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
  }

  formatFileSize(bytes: number) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
