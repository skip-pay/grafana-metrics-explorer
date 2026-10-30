import { FilterGroup, FilterItem, TagFilter } from '../model/types';
import {
  filterBranches,
  filterTerms,
  filterToText,
  filtersToMatchers,
  MAX_BRANCHES,
  parseScopeText,
  promString,
  renderScope,
  topLevelFilters,
} from './filters';

const eq = (key: string, value: string): TagFilter => ({ key, op: 'eq', values: [value] });
const neq = (key: string, value: string): TagFilter => ({ key, op: 'neq', values: [value] });
const isIn = (key: string, ...values: string[]): TagFilter => ({ key, op: 'in', values });
const notIn = (key: string, ...values: string[]): TagFilter => ({ key, op: 'not_in', values });
const or = (...items: FilterItem[]): FilterGroup => ({ op: 'or', items });
const and = (...items: FilterItem[]): FilterGroup => ({ op: 'and', items });
const not = (group: FilterGroup): FilterGroup => ({ op: group.op, negated: true, items: group.items });

describe('filtersToMatchers', () => {
  it('compiles each chip kind', () => {
    expect(filtersToMatchers([eq('environment', 'prod')])).toEqual(['environment="prod"']);
    expect(filtersToMatchers([neq('path', '/health')])).toEqual(['path!="/health"']);
    expect(filtersToMatchers([eq('service', 'api*')])).toEqual(['service=~"(?:api.*)"']);
    expect(filtersToMatchers([eq('service', '*')])).toEqual(['service=~"(?:.+)"']);
    expect(filtersToMatchers([neq('path', '/v1/*/x')])).toEqual(['path!~"(?:/v1/.*/x)"']);
    expect(filtersToMatchers([{ key: 'env', op: 'in', values: ['prod', 'staging'] }])).toEqual([
      'env=~"(?:prod|staging)"',
    ]);
    expect(filtersToMatchers([{ key: 'env', op: 'not_in', values: ['prod', 'staging'] }])).toEqual([
      'env!~"(?:prod|staging)"',
    ]);
  });

  it('ORs eq chips of one key at the position of the first one', () => {
    expect(filtersToMatchers([eq('env', 'prod'), neq('path', '/x'), eq('env', 'stag*'), eq('method', 'GET')])).toEqual([
      'env=~"(?:prod|stag.*)"',
      'path!="/x"',
      'method="GET"',
    ]);
  });

  it('keeps several negations of one key as separate matchers', () => {
    expect(filtersToMatchers([neq('path', '/a'), neq('path', '/b')])).toEqual(['path!="/a"', 'path!="/b"']);
  });

  it('escapes regex metacharacters and string quotes', () => {
    expect(filtersToMatchers([eq('q', 'a.b*')])).toEqual(['q=~"(?:a\\\\.b.*)"']);
    expect(filtersToMatchers([{ key: 'path', op: 'in', values: ['/v1/(x)', 'a|b', 'c*'] }])).toEqual([
      'path=~"(?:/v1/\\\\(x\\\\)|a\\\\|b|c\\\\*)"',
    ]);
    expect(filtersToMatchers([eq('msg', 'say "hi" \\ bye')])).toEqual(['msg="say \\"hi\\" \\\\ bye"']);
  });

  it('returns nothing for no filters', () => {
    expect(filtersToMatchers([])).toEqual([]);
  });
});

describe('promString', () => {
  it('escapes backslashes, quotes and newlines', () => {
    expect(promString('a\\b"c\nd')).toBe('"a\\\\b\\"c\\nd"');
  });
});

describe('filter text', () => {
  it.each<[TagFilter, string]>([
    [eq('environment', 'prod'), 'environment:prod'],
    [neq('path', '/health'), '!path:/health'],
    [eq('service', 'api*'), 'service:api*'],
    [eq('service', '*'), 'service:*'],
    [eq('url', 'http://x:8000'), 'url:http://x:8000'],
    [eq('path', '/v1/{id}'), 'path:"/v1/{id}"'],
    [eq('a', 'x,y'), 'a:"x,y"'],
    [eq('a', ' padded'), 'a:" padded"'],
    [eq('a', 'say "hi"'), 'a:"say \\"hi\\""'],
    [eq('a', 'x OR y'), 'a:"x OR y"'],
    [eq('a', 'salt AND'), 'a:"salt AND"'],
    [eq('a', 'do NOT touch'), 'a:do NOT touch'],
    [eq('a', 'café crème'), 'a:café crème'],
    [eq('a', 'f(x)'), 'a:"f(x)"'],
    [isIn('env', 'prod', 'staging'), 'env IN (prod,staging)'],
    [notIn('env', 'a(1)', 'b'), 'env NOT IN ("a(1)",b)'],
  ])('%j <-> %s', (filter, text) => {
    expect(filterToText(filter)).toBe(text);
    expect(parseScopeText(text)).toEqual([filter]);
  });

  it('accepts loose spacing and a lowercase IN', () => {
    expect(parseScopeText('  ! path : /x ')).toEqual([neq('path', '/x')]);
    expect(parseScopeText('env in ( prod , staging )')).toEqual([isIn('env', 'prod', 'staging')]);
    expect(parseScopeText('env not in (prod)')).toEqual([notIn('env', 'prod')]);
  });

  it.each([
    ['environment', 'Expected key:value, got "environment"'],
    ['env AND x:y', 'Expected key:value, got "env"'],
    ['bad-key:x', 'Invalid tag key "bad-key"'],
    ['env:', 'Missing value for "env"'],
    ['!env:*', '!env:* (tag absent) is not supported'],
    ['NOT env:*', 'NOT env:* (tag absent) is not supported'],
    ['env:"open', 'Unterminated quote in "open'],
    ['env:"a"b', 'Unexpected text after the quoted value "a"'],
    ['env:a"b', 'Unexpected quote in the value of "env"'],
    ['path:/v1/(x)', 'Unexpected "(" in the value of "path"; quote values that contain parentheses'],
    ['env IN (a,,b)', 'Empty value in env IN (…)'],
    ['env NOT IN ()', 'Empty value in env NOT IN (…)'],
    ['env IN (a', 'Missing ")" in env IN (…)'],
    ['$env', 'Template variables are not supported'],
  ])('rejects %j', (text, message) => {
    expect(parseScopeText(text)).toEqual({ error: message });
  });
});

describe('scope text', () => {
  it('renders and parses the everywhere scope', () => {
    expect(renderScope([])).toBe('*');
    expect(parseScopeText('*')).toEqual([]);
    expect(parseScopeText(' ')).toEqual([]);
  });

  it('splits a comma list at top-level commas only', () => {
    expect(parseScopeText('a:1, !b:2,c IN (x,y),d:"p,q"')).toEqual([
      eq('a', '1'),
      neq('b', '2'),
      isIn('c', 'x', 'y'),
      eq('d', 'p,q'),
    ]);
  });

  it('binds NOT tighter than AND, and AND (or a comma) tighter than OR', () => {
    expect(parseScopeText('a:1 OR b:2 AND c:3')).toEqual([or(eq('a', '1'), and(eq('b', '2'), eq('c', '3')))]);
    expect(parseScopeText('a:1 AND b:2 OR c:3')).toEqual([or(and(eq('a', '1'), eq('b', '2')), eq('c', '3'))]);
    expect(parseScopeText('a:1, b:2 OR c:3')).toEqual([or(and(eq('a', '1'), eq('b', '2')), eq('c', '3'))]);
    expect(parseScopeText('NOT a:1 AND b:2')).toEqual([neq('a', '1'), eq('b', '2')]);
    expect(parseScopeText('NOT a:1 OR b:2')).toEqual([or(neq('a', '1'), eq('b', '2'))]);
    expect(parseScopeText('(a:1 OR b:2) AND c:3')).toEqual([or(eq('a', '1'), eq('b', '2')), eq('c', '3')]);
  });

  it('parses the documented examples', () => {
    expect(parseScopeText('env:prod AND (service:api OR service:worker), !status:5*')).toEqual([
      eq('env', 'prod'),
      or(eq('service', 'api'), eq('service', 'worker')),
      neq('status', '5*'),
    ]);
    expect(parseScopeText('env:prod, NOT (method:GET OR method:HEAD)')).toEqual([
      eq('env', 'prod'),
      not(or(eq('method', 'GET'), eq('method', 'HEAD'))),
    ]);
  });

  it('turns NOT of a term into its complement and toggles the negation of a group', () => {
    expect(parseScopeText('NOT !a:1, NOT a IN (x,y), NOT b NOT IN (z)')).toEqual([
      eq('a', '1'),
      notIn('a', 'x', 'y'),
      isIn('b', 'z'),
    ]);
    expect(parseScopeText('NOT (a:1 AND b:2)')).toEqual([not(and(eq('a', '1'), eq('b', '2')))]);
    expect(parseScopeText('NOT NOT (a:1 OR b:2)')).toEqual([or(eq('a', '1'), eq('b', '2'))]);
    expect(parseScopeText('NOT(a:1 OR b:2)')).toEqual([not(or(eq('a', '1'), eq('b', '2')))]);
  });

  it('drops redundant parentheses and flattens groups of the same operator', () => {
    expect(parseScopeText('((a:1))')).toEqual([eq('a', '1')]);
    expect(parseScopeText('(a:1 OR (b:2 OR c:3))')).toEqual([or(eq('a', '1'), eq('b', '2'), eq('c', '3'))]);
    expect(parseScopeText('a:1 AND (b:2 AND c:3)')).toEqual([eq('a', '1'), eq('b', '2'), eq('c', '3')]);
    expect(parseScopeText('x:1 OR NOT (a:1 OR b:2)')).toEqual([or(eq('x', '1'), not(or(eq('a', '1'), eq('b', '2'))))]);
    expect(parseScopeText('a:1 AND(b:2 OR c:3)')).toEqual([eq('a', '1'), or(eq('b', '2'), eq('c', '3'))]);
  });

  it('reads keywords in uppercase only; elsewhere they are part of a value or a key', () => {
    expect(parseScopeText('a:1 or b:2')).toEqual([eq('a', '1 or b:2')]);
    expect(parseScopeText('msg:do NOT touch')).toEqual([eq('msg', 'do NOT touch')]);
    expect(parseScopeText('AND:x, OR:y')).toEqual([eq('AND', 'x'), eq('OR', 'y')]);
    expect(parseScopeText('msg:"a OR b" OR msg:c')).toEqual([or(eq('msg', 'a OR b'), eq('msg', 'c'))]);
  });

  it.each([
    ['a:1 OR', 'Expected a filter after "OR"'],
    ['a:1 AND', 'Expected a filter after "AND"'],
    ['a:1,', 'Expected a filter after ","'],
    ['NOT', 'Expected a filter after "NOT"'],
    ['()', 'Expected a filter after "("'],
    ['OR a:1', 'Expected a filter before "OR"'],
    [', a:1', 'Expected a filter before ","'],
    ['(a:1 OR b:2', 'Missing ")"'],
    ['a:1)', 'Unexpected ")"'],
    ['env:prod NOT (a:1)', 'Expected AND, OR or "," before NOT'],
    ['env IN (a) x', 'Unexpected text "x"'],
    ['(env IN (a) x)', 'Unexpected text "x)"'],
  ])('rejects %j', (text, message) => {
    expect(parseScopeText(text)).toEqual({ error: message });
  });

  it.each<[FilterItem[], string]>([
    [
      [eq('env', 'prod'), or(eq('service', 'api'), eq('service', 'worker')), neq('status', '5*')],
      'env:prod,(service:api OR service:worker),!status:5*',
    ],
    [
      [eq('env', 'prod'), not(or(eq('method', 'GET'), eq('method', 'HEAD')))],
      'env:prod,NOT (method:GET OR method:HEAD)',
    ],
    [
      [or(and(eq('a', '1'), neq('b', '2')), not(and(eq('c', '3'), eq('d', '4'))), isIn('e', 'x', 'y'))],
      '((a:1 AND !b:2) OR NOT (c:3 AND d:4) OR e IN (x,y))',
    ],
    [
      [or(eq('msg', 'x OR y'), eq('msg', 'a,b'), notIn('path', '/v1/(x)'))],
      '(msg:"x OR y" OR msg:"a,b" OR path NOT IN ("/v1/(x)"))',
    ],
    [[not(and(eq('a', '1'), or(eq('b', '2'), eq('c', '3'))))], 'NOT (a:1 AND (b:2 OR c:3))'],
  ])('renders %j as %s and parses it back', (items, text) => {
    expect(renderScope(items)).toBe(text);
    expect(parseScopeText(text)).toEqual(items);
  });
});

describe('filter terms', () => {
  const items = [eq('a', '1'), or(neq('b', '2'), and(eq('c', '3'), isIn('d', 'x'))), notIn('e', 'y')];

  it('lists every term, inside groups too', () => {
    expect(filterTerms(items).map((f) => f.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps only the top-level terms for scoping', () => {
    expect(topLevelFilters(items)).toEqual([eq('a', '1'), notIn('e', 'y')]);
  });
});

describe('filterBranches', () => {
  it('compiles a list without groups to one branch, as filtersToMatchers', () => {
    const filters = [eq('env', 'prod'), neq('path', '/x'), eq('env', 'stag*'), isIn('method', 'GET')];
    expect(filterBranches(filters)).toEqual([filtersToMatchers(filters)]);
    expect(filterBranches([])).toEqual([[]]);
  });

  it('merges an OR over one key into a regex alternation', () => {
    expect(
      filterBranches([eq('env', 'prod'), or(eq('service', 'api'), eq('service', 'work*')), neq('status', '5*')])
    ).toEqual([['env="prod"', 'service=~"(?:api|work.*)"', 'status!~"(?:5.*)"']]);
    expect(filterBranches([or(isIn('env', 'a', 'b'), eq('env', 'c'))])).toEqual([['env=~"(?:a|b|c)"']]);
    expect(filterBranches([or(eq('a', '1'), eq('a', '2')), or(eq('b', '1'), eq('b', '2'))])).toEqual([
      ['a=~"(?:1|2)"', 'b=~"(?:1|2)"'],
    ]);
  });

  it('keeps branches that differ in more than one key, or in a negation', () => {
    expect(filterBranches([or(and(eq('a', '1'), eq('b', '1')), and(eq('a', '2'), eq('b', '2')))])).toEqual([
      ['a="1"', 'b="1"'],
      ['a="2"', 'b="2"'],
    ]);
    expect(filterBranches([or(eq('service', 'api'), eq('path', '/x'))])).toEqual([['service="api"'], ['path="/x"']]);
    expect(filterBranches([or(neq('a', '1'), neq('a', '2'))])).toEqual([['a!="1"'], ['a!="2"']]);
  });

  it('pushes NOT down to the terms', () => {
    expect(filterBranches([eq('env', 'prod'), not(or(eq('method', 'GET'), eq('method', 'HEAD')))])).toEqual([
      ['env="prod"', 'method!="GET"', 'method!="HEAD"'],
    ]);
    expect(filterBranches([not(and(eq('a', '1'), isIn('b', 'x', 'y')))])).toEqual([['a!="1"'], ['b!~"(?:x|y)"']]);
    expect(filterBranches([not(and(eq('a', '1'), not(or(eq('b', '2'), neq('c', '3')))))])).toEqual([
      ['a!="1"'],
      ['b="2"'],
      ['c!="3"'],
    ]);
  });

  it('ORs eq terms of one key only within one AND list', () => {
    expect(filterBranches([not(and(eq('env', 'a'), eq('env', 'b')))])).toEqual([['env!~"(?:a|b)"']]);
    expect(filterBranches([eq('env', 'prod'), or(eq('env', 'staging'), eq('x', 'y'))])).toEqual([
      ['env="prod"', 'env="staging"'],
      ['env="prod"', 'x="y"'],
    ]);
  });

  it('drops duplicate and absorbed branches', () => {
    expect(filterBranches([or(eq('env', 'prod'), and(eq('env', 'prod'), eq('method', 'GET')))])).toEqual([
      ['env="prod"'],
    ]);
    expect(filterBranches([or(and(eq('a', '1'), eq('b', '2')), and(eq('b', '2'), eq('a', '1')))])).toEqual([
      ['a="1"', 'b="2"'],
    ]);
  });

  it(`allows ${MAX_BRANCHES} branches and refuses more`, () => {
    const terms = (n: number) => Array.from({ length: n }, (_, i) => eq(`k${i}`, 'x'));
    expect(filterBranches([or(...terms(MAX_BRANCHES))])).toHaveLength(MAX_BRANCHES);
    expect(filterBranches([or(...terms(MAX_BRANCHES + 1))])).toEqual({
      error: 'The filter expands to more than 16 OR branches; simplify it or list the values of a tag with IN (…)',
    });
  });

  it('stops expanding a cross product of many groups or a long OR early', () => {
    const groups = Array.from({ length: 30 }, (_, i) => or(eq(`a${i}`, 'x'), eq(`b${i}`, 'x')));
    expect(filterBranches(groups)).toEqual({ error: expect.stringContaining('more than 16 OR branches') });
    const terms = (n: number, key: (i: number) => string) => Array.from({ length: n }, (_, i) => eq(key(i), `v${i}`));
    expect(filterBranches([or(...terms(1000, (i) => `k${i}`))])).toEqual({
      error: expect.stringContaining('more than 16 OR branches'),
    });
    expect(filterBranches([or(...terms(200, () => 'k'))])).toEqual([
      [expect.stringMatching(/^k=~"\(\?:v0\|v1\|.*\|v199\)"$/)],
    ]);
    const pairs = Array.from({ length: 7 }, (_, i) => or(eq(`a${i}`, 'x'), eq(`b${i}`, 'x')));
    const long = Array.from({ length: 60 }, (_, i) => eq(`t${i}`, 'v'.repeat(100)));
    expect(filterBranches([...pairs, ...long])).toEqual({ error: expect.stringContaining('more than 16') });
    expect(filterBranches([...long, ...pairs])).toEqual({ error: expect.stringContaining('more than 16') });
  });

  it('merges a long OR of expanded groups back to few branches', () => {
    const forks = ['a', 'c', 'e', 'g'].map((k) => or(eq(k, '1'), eq(`${k}${k}`, '1')));
    const copies = Array.from({ length: MAX_BRANCHES }, (_, i) => and(eq('k', `v${i}`), ...forks));
    const branches = filterBranches([or(...copies)]);
    expect(branches).toHaveLength(MAX_BRANCHES);
    expect((branches as string[][])[0]).toEqual([
      expect.stringMatching(/^k=~"\(\?:v0\|v1\|.*\|v15\)"$/),
      'a="1"',
      'c="1"',
      'e="1"',
      'g="1"',
    ]);
  });

  it('refuses a negated key:*', () => {
    expect(filterBranches([not(or(eq('env', '*'), eq('x', 'y')))])).toEqual({
      error: 'Filtering on a missing tag (!key:*) is not supported',
    });
    expect(filterBranches([neq('env', '*')])).toEqual({
      error: 'Filtering on a missing tag (!key:*) is not supported',
    });
  });
});
