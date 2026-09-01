import { Component } from '@angular/core';

@Component({
  selector: 'app-convert-page',
  standalone: true,
  templateUrl: './convert.page.html',
  styleUrl: './convert.page.scss',
})
export class ConvertPage {
  title = 'Anything To Anything';

  description = 'Convert anything into anything.';

  count = 0;

  increment() {
    this.count++;
  }
}
