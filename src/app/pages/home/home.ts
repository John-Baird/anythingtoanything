import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  standalone: true,
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  title = 'Anything To Anything';

  description = 'Convert anything into anything.';

  count = 0;

  increment() {
    this.count++;
  }
}
