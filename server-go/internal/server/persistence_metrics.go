package server

import (
	"os"
	"sync/atomic"
	"time"
)

type PersistenceStats struct {
	SnapshotCalls           int64 `json:"snapshotCalls"`
	SnapshotMessagesCloned  int64 `json:"snapshotMessagesCloned"`
	SnapshotDurationTotalNS int64 `json:"snapshotDurationTotalNs"`
	SnapshotDurationLastNS  int64 `json:"snapshotDurationLastNs"`
	SnapshotDurationMaxNS   int64 `json:"snapshotDurationMaxNs"`
	SaveCalls               int64 `json:"saveCalls"`
	SaveFailures            int64 `json:"saveFailures"`
	SavesInFlight           int64 `json:"savesInFlight"`
	MessagesExamined        int64 `json:"messagesExamined"`
	SaveDurationTotalNS     int64 `json:"saveDurationTotalNs"`
	SaveDurationLastNS      int64 `json:"saveDurationLastNs"`
	SaveDurationMaxNS       int64 `json:"saveDurationMaxNs"`
	LockWaitTotalNS         int64 `json:"lockWaitTotalNs"`
	LockWaitLastNS          int64 `json:"lockWaitLastNs"`
	LockWaitMaxNS           int64 `json:"lockWaitMaxNs"`
	TransactionTotalNS      int64 `json:"transactionTotalNs"`
	TransactionLastNS       int64 `json:"transactionLastNs"`
	TransactionMaxNS        int64 `json:"transactionMaxNs"`
	DatabaseBytes           int64 `json:"databaseBytes"`
	WALBytes                int64 `json:"walBytes"`
}

func (stats *PersistenceStats) add(other PersistenceStats) {
	stats.SnapshotCalls += other.SnapshotCalls
	stats.SnapshotMessagesCloned += other.SnapshotMessagesCloned
	stats.SnapshotDurationTotalNS += other.SnapshotDurationTotalNS
	stats.SnapshotDurationLastNS = max(stats.SnapshotDurationLastNS, other.SnapshotDurationLastNS)
	stats.SnapshotDurationMaxNS = max(stats.SnapshotDurationMaxNS, other.SnapshotDurationMaxNS)
	stats.SaveCalls += other.SaveCalls
	stats.SaveFailures += other.SaveFailures
	stats.SavesInFlight += other.SavesInFlight
	stats.MessagesExamined += other.MessagesExamined
	stats.SaveDurationTotalNS += other.SaveDurationTotalNS
	stats.SaveDurationLastNS = max(stats.SaveDurationLastNS, other.SaveDurationLastNS)
	stats.SaveDurationMaxNS = max(stats.SaveDurationMaxNS, other.SaveDurationMaxNS)
	stats.LockWaitTotalNS += other.LockWaitTotalNS
	stats.LockWaitLastNS = max(stats.LockWaitLastNS, other.LockWaitLastNS)
	stats.LockWaitMaxNS = max(stats.LockWaitMaxNS, other.LockWaitMaxNS)
	stats.TransactionTotalNS += other.TransactionTotalNS
	stats.TransactionLastNS = max(stats.TransactionLastNS, other.TransactionLastNS)
	stats.TransactionMaxNS = max(stats.TransactionMaxNS, other.TransactionMaxNS)
	stats.DatabaseBytes += other.DatabaseBytes
	stats.WALBytes += other.WALBytes
}

type persistenceCounters struct {
	snapshotCalls           atomic.Int64
	snapshotMessagesCloned  atomic.Int64
	snapshotDurationTotalNS atomic.Int64
	snapshotDurationLastNS  atomic.Int64
	snapshotDurationMaxNS   atomic.Int64
	saveCalls               atomic.Int64
	saveFailures            atomic.Int64
	savesInFlight           atomic.Int64
	messagesExamined        atomic.Int64
	saveDurationTotalNS     atomic.Int64
	saveDurationLastNS      atomic.Int64
	saveDurationMaxNS       atomic.Int64
	lockWaitTotalNS         atomic.Int64
	lockWaitLastNS          atomic.Int64
	lockWaitMaxNS           atomic.Int64
	transactionTotalNS      atomic.Int64
	transactionLastNS       atomic.Int64
	transactionMaxNS        atomic.Int64
}

func (c *persistenceCounters) recordSnapshot(duration time.Duration, messageCount int) {
	nanoseconds := duration.Nanoseconds()
	c.snapshotCalls.Add(1)
	c.snapshotMessagesCloned.Add(int64(messageCount))
	c.snapshotDurationTotalNS.Add(nanoseconds)
	c.snapshotDurationLastNS.Store(nanoseconds)
	storeAtomicMax(&c.snapshotDurationMaxNS, nanoseconds)
}

func (c *persistenceCounters) snapshot() PersistenceStats {
	return PersistenceStats{
		SnapshotCalls:           c.snapshotCalls.Load(),
		SnapshotMessagesCloned:  c.snapshotMessagesCloned.Load(),
		SnapshotDurationTotalNS: c.snapshotDurationTotalNS.Load(),
		SnapshotDurationLastNS:  c.snapshotDurationLastNS.Load(),
		SnapshotDurationMaxNS:   c.snapshotDurationMaxNS.Load(),
		SaveCalls:               c.saveCalls.Load(),
		SaveFailures:            c.saveFailures.Load(),
		SavesInFlight:           c.savesInFlight.Load(),
		MessagesExamined:        c.messagesExamined.Load(),
		SaveDurationTotalNS:     c.saveDurationTotalNS.Load(),
		SaveDurationLastNS:      c.saveDurationLastNS.Load(),
		SaveDurationMaxNS:       c.saveDurationMaxNS.Load(),
		LockWaitTotalNS:         c.lockWaitTotalNS.Load(),
		LockWaitLastNS:          c.lockWaitLastNS.Load(),
		LockWaitMaxNS:           c.lockWaitMaxNS.Load(),
		TransactionTotalNS:      c.transactionTotalNS.Load(),
		TransactionLastNS:       c.transactionLastNS.Load(),
		TransactionMaxNS:        c.transactionMaxNS.Load(),
	}
}

func (c *persistenceCounters) recordDuration(total, last, maximum *atomic.Int64, duration time.Duration) {
	nanoseconds := duration.Nanoseconds()
	total.Add(nanoseconds)
	last.Store(nanoseconds)
	storeAtomicMax(maximum, nanoseconds)
}

func storeAtomicMax(target *atomic.Int64, value int64) {
	for {
		current := target.Load()
		if value <= current || target.CompareAndSwap(current, value) {
			return
		}
	}
}

func countMessages(messages Messages) int {
	count := 0
	for _, roomMessages := range messages {
		count += len(roomMessages)
	}
	return count
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
