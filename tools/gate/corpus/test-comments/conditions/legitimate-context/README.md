# queue

A bounded FIFO queue.

`push` signals a full queue by returning `false` rather than throwing,
because producers back off on the boolean; that is the intended API.
