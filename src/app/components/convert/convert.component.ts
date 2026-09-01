import { Component } from '@angular/core';

@Component({
  selector: 'app-convert-component',
  standalone: true,
  templateUrl: './convert.component.html',
  styleUrl: './convert.component.scss',
})
export class ConvertComponent {
  selectedFile: File | null = null;
  isDragging = false;

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
      this.selectedFile = file;
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;

    const file = input.files?.[0];

    if (file) {
      this.selectedFile = file;
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
