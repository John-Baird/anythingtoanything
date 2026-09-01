import { Component, OnDestroy, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

type State = 'idle' | 'selected' | 'queued' | 'processing' | 'done';

interface JobStatus {
  status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled';
  kind: string;
  progress: number;
  ahead: number | null;
  position: number | null;
  ready: boolean;
  error: string | null;
  downloadName: string | null;
}

@Component({
  selector: 'app-convert-component',
  standalone: true,
  imports: [],
  templateUrl: './convert.component.html',
  styleUrl: './convert.component.scss',
})
export class ConvertComponent implements OnDestroy {
  private http = inject(HttpClient);

  state = signal<State>('idle');
  isDragging = signal(false);

  selectedFile: File | null = null;
  selectedFormat = signal<string | null>(null);
  targetFormats = signal<string[]>([]);
  errorMessage = signal('');

  // queue / progress feedback
  queuePosition = signal<number | null>(null);
  progressPct = signal(0);
  jobKind = signal('');

  outputName = signal('');
  downloadUrl = signal('');

  private jobId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy() {
    this.stopPolling();
  }

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
    this.reset();
    this.selectedFile = file;

    this.http
      .get<{ kind: string; targets: string[] }>('/api/formats', {
        params: { filename: file.name },
      })
      .subscribe({
        next: (res) => {
          console.log('[formats]', file.name, '->', res);

          if (res.kind === 'unsupported' || res.targets.length === 0) {
            this.selectedFile = null;
            this.state.set('idle');
            this.errorMessage.set(
              "That file type isn't supported yet. Try an image (JPG, PNG, WebP, GIF, TIFF, AVIF), audio (MP3, WAV, FLAC, OGG, M4A), video (MP4, MOV, WebM, MKV), a document (TXT, MD, HTML, DOCX, PDF), a spreadsheet (CSV, XLSX, XLS), or an archive (ZIP, 7Z, RAR, TAR, GZ).",
            );
            return;
          }

          this.jobKind.set(res.kind);
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

    this.errorMessage.set('');
    this.progressPct.set(0);
    this.queuePosition.set(null);
    this.state.set('queued');
    console.log('[convert] uploading', file.name, '->', format);

    this.http.post<{ jobId: string }>('/api/convert', form).subscribe({
      next: (res) => {
        console.log('[convert] job', res.jobId);
        this.jobId = res.jobId;
        this.startPolling();
      },
      error: async (err) => {
        this.errorMessage.set(await readError(err));
        this.state.set('selected');
      },
    });
  }

  private startPolling() {
    this.stopPolling();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 1000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll() {
    if (!this.jobId) {
      return;
    }

    this.http.get<JobStatus>(`/api/jobs/${this.jobId}`).subscribe({
      next: (job) => {
        if (job.status === 'queued') {
          this.queuePosition.set(job.position ?? (job.ahead ?? 0) + 1);
          this.state.set('queued');
        } else if (job.status === 'processing') {
          this.progressPct.set(job.progress);
          this.state.set('processing');
        } else if (job.status === 'done') {
          this.stopPolling();
          this.progressPct.set(100);
          this.outputName.set(job.downloadName ?? 'converted');
          this.downloadUrl.set(`/api/jobs/${this.jobId}/download`);
          this.state.set('done');
        } else if (job.status === 'error') {
          this.stopPolling();
          this.errorMessage.set(job.error ?? 'Conversion failed');
          this.state.set('selected');
        } else if (job.status === 'cancelled') {
          this.stopPolling();
          this.errorMessage.set('Conversion was cancelled.');
          this.state.set('selected');
        }
      },
      error: (err) => {
        console.error('[poll] failed', err);
        this.stopPolling();
        this.errorMessage.set('Lost contact with the server.');
        this.state.set('selected');
      },
    });
  }

  queueText() {
    const pos = this.queuePosition();
    if (pos === null) {
      return 'Finding your place in line…';
    }
    return `${ordinal(pos)} in queue`;
  }

  reset() {
    this.stopPolling();
    this.jobId = null;
    this.selectedFile = null;
    this.selectedFormat.set(null);
    this.targetFormats.set([]);
    this.errorMessage.set('');
    this.queuePosition.set(null);
    this.progressPct.set(0);
    this.jobKind.set('');
    this.outputName.set('');
    this.downloadUrl.set('');
    this.state.set('idle');
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

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

async function readError(err: unknown): Promise<string> {
  const e = err as { error?: unknown; message?: string };
  if (e.error instanceof Blob) {
    try {
      return JSON.parse(await e.error.text()).error ?? 'Upload failed';
    } catch {
      return 'Upload failed';
    }
  }
  if (e.error && typeof e.error === 'object' && 'error' in e.error) {
    return String((e.error as { error: unknown }).error);
  }
  return e.message ?? 'Upload failed';
}
