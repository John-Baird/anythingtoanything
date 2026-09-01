import { Component, inject } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-convert-component',
  standalone: true,
  imports: [JsonPipe],
  templateUrl: './convert.component.html',
  styleUrl: './convert.component.scss',
})
export class ConvertComponent {
  private http = inject(HttpClient);

  selectedFile: File | null = null;
  isDragging = false;
  status: 'idle' | 'uploading' | 'done' | 'error' = 'idle';
  result: unknown = null;

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragging = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragging = false;
  }

  onDrop(event: DragEvent) {
    event.preventDefault();

    this.isDragging = false;

    const file = event.dataTransfer?.files?.[0];

    if (file) {
      this.setFile(file);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;

    const file = input.files?.[0];

    if (file) {
      this.setFile(file);
    }
  }

  private setFile(file: File) {
    this.selectedFile = file;
    this.status = 'idle';
    this.result = null;
  }

  upload() {
    if (!this.selectedFile) {
      return;
    }

    const form = new FormData();
    form.append('file', this.selectedFile, this.selectedFile.name);

    this.status = 'uploading';
    this.http.post('/api/upload', form).subscribe({
      next: (res) => {
        this.result = res;
        this.status = 'done';
      },
      error: (err) => {
        this.result = err.error ?? err.message;
        this.status = 'error';
      },
    });
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
