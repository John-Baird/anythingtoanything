// Single-process FIFO job queue with a fixed worker count.
//
// IMPORTANT: this lives in memory, so it only works when the server runs as ONE
// process. Do not add Node clustering or scale to multiple Render instances
// without moving the queue to Redis (e.g. BullMQ) — each process would get its
// own independent queue.

class JobQueue {
	constructor({ concurrency = 1 } = {}) {
		this.concurrency = Math.max(1, concurrency);
		this.pending = []; // [{ id, run, resolve, reject }]
		this.active = new Set(); // job ids currently running
	}

	// Queue a job. Returns a promise that settles when the job finishes running.
	add(id, run) {
		return new Promise((resolve, reject) => {
			this.pending.push({ id, run, resolve, reject });
			this._drain();
		});
	}

	// How many jobs are ahead of `id` in line. 0 means "next up".
	// -1 means it is not waiting (already running, finished, or unknown).
	positionOf(id) {
		return this.pending.findIndex((job) => job.id === id);
	}

	isActive(id) {
		return this.active.has(id);
	}

	// Remove a still-waiting job from the queue. Returns true if it was removed.
	cancel(id) {
		const index = this.pending.findIndex((job) => job.id === id);
		if (index === -1) {
			return false;
		}
		const [job] = this.pending.splice(index, 1);
		job.reject(new Error("cancelled"));
		return true;
	}

	_drain() {
		while (this.active.size < this.concurrency && this.pending.length > 0) {
			const job = this.pending.shift();
			this.active.add(job.id);

			Promise.resolve()
				.then(() => job.run())
				.then(job.resolve, job.reject)
				.finally(() => {
					this.active.delete(job.id);
					this._drain();
				});
		}
	}
}

module.exports = { JobQueue };
