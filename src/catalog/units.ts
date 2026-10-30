export interface UnitInfo {
  unit?: string;
  unitLabel?: string;
}

const UNIT_LABELS: Record<string, string> = {
  percent: 'Percent',
  ns: 'Nanoseconds',
  µs: 'Microseconds',
  ms: 'Milliseconds',
  s: 'Seconds',
  bytes: 'Bytes',
  kbytes: 'Kilobytes',
  mbytes: 'Megabytes',
  Bps: 'Bytes/s',
  KiBs: 'Kilobytes/s',
  iops: 'IOPS',
  currencyUSD: 'USD',
};

function unitOf(unit: string, unitLabel = UNIT_LABELS[unit]): UnitInfo {
  return unitLabel ? { unit, unitLabel } : { unit };
}

/** The unit of an OTel metadata unit string; undefined when the string is empty or unknown. */
export function unitFromMetadata(unit: string): UnitInfo | undefined {
  switch (unit) {
    case 's':
    case 'second':
      return unitOf('s');
    case 'ms':
    case 'millisecond':
      return unitOf('ms');
    case 'By':
    case 'bytes':
      return unitOf('bytes');
    case '1':
    case 'currency':
      return unitOf('short');
  }
  // Annotations such as `{task}` count things: short with the plural as the axis label.
  const annotation = /^\{(\w+)\}$/.exec(unit);
  if (annotation) {
    const word = annotation[1];
    return unitOf('short', `${word[0].toUpperCase()}${word.slice(1)}s`);
  }
  return undefined;
}

// Name heuristics for metrics without metadata, in order; the suffix rules beat the topic words.
const NAME_UNITS: Array<[RegExp, string]> = [
  [/timestamp/, ''],
  [/_seconds(_total)?$/, 's'],
  [/_bytes(_total)?$/, 'bytes'],
  [/_(ms|milliseconds)$/, 'ms'],
  [/_usd$/, 'currencyUSD'],
  [/_rss$/, 'bytes'],
  [/utilization|percent|cpu/, 'percent'],
];

export function unitFromName(name: string): UnitInfo | undefined {
  const rule = NAME_UNITS.find(([pattern]) => pattern.test(name));
  return rule && rule[1] ? unitOf(rule[1]) : undefined;
}

// CloudWatch units by namespace (null: any) and lower-cased metric name; first match wins, the rest are counts.
const CLOUDWATCH_UNITS: Array<[string | null, RegExp, string]> = [
  ['applicationelb', /^targetresponsetime$/, 's'],
  ['applicationelb', /^elbauthlatency$/, 'ms'],
  ['ebs', /^volumeavg(read|write)latency$/, 'ms'],
  ['ebs', /^volume(idletime|total(read|write)time)$/, 's'],
  ['ecs', /reservation$/, 'percent'],
  ['elasticache', /latency$/, 'µs'],
  ['elasticache', /^db0averagettl$/, 'ms'],
  ['elasticache', /^replicationlag$/, 's'],
  ['elasticache', /^cachehitrate$/, 'percent'],
  ['es', /^(freestoragespace|clusterusedspace|kibanaheap(total|used))$/, 'mbytes'],
  ['es', /^knngraphmemoryusage$/, 'kbytes'],
  ['es', /^(searchlatency|indexinglatency|jvmgc\w+collectiontime|kibanaresponsetimesmaxinmillis)$/, 'ms'],
  ['es', /^knntotalloadtime$/, 'ns'],
  ['es', /jvmmemorypressure$/, 'percent'],
  ['lambda', /^(duration|asynceventage)$/, 'ms'],
  [
    'rds',
    /^os(memory(?!hugepages(free|reserved|total|surplus)$)|swap(cached|free|total)$)|^filesysspace(available|used)$/,
    'kbytes',
  ],
  ['rds', /^osswap(in|out)$/, 'KiBs'],
  ['rds', /^(commitlatency|dbblocksreadlatency|db\w*readtimes?)$/, 'ms'],
  ['rds', /^(engineuptime|longestidleintransaction|checkpointlag|rdstoaurorapostgresqlreplicalag)$/, 's'],
  [
    'rds',
    /^(oldest(logical)?replicationslotlag|\w+diskusage|tempfilessize|\w*storage(used|billed)|freelocalstorage|freestoragespace)$/,
    'bytes',
  ],
  ['rds', /^transactionlogsgeneration$/, 'Bps'],
  ['rds', /^volume(read|write)iops$/, 'short'],
  ['rds', /^buffercachehitratio$/, 'percent'],
  ['sqs', /^approximateageofoldestmessage/, 's'],
  ['sqs', /^sentmessagesize$/, 'bytes'],
  [null, /utilization|percent/, 'percent'],
  [null, /^(ebsbyte|ebsio|burst)balance$/, 'percent'],
  [null, /latency$/, 's'],
  [null, /throughput(microbursting)?$/, 'Bps'],
  [null, /iops(microbursting)?$/, 'iops'],
  [null, /bytes|^(freeablememory|swapusage|usedmemorydataset|network(in|out))$/, 'bytes'],
];

/** `amazonaws_com_aws_rds_cpuutilization` → namespace `rds`, metric `cpuutilization`. */
const CLOUDWATCH_NAME = /^amazonaws_com_(?:aws_)?([a-z0-9]+)_(.+)$/;

export function cloudWatchUnit(name: string): UnitInfo {
  const parts = CLOUDWATCH_NAME.exec(name);
  if (!parts) {
    return unitOf('short');
  }
  const [, namespace, metric] = parts;
  const rule = CLOUDWATCH_UNITS.find(([ns, pattern]) => (ns === null || ns === namespace) && pattern.test(metric));
  return unitOf(rule ? rule[2] : 'short');
}
