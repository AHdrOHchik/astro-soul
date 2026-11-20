export interface HistoryPageCache<Item> {
  items: Item[];
  total: number;
  /** Offset of the next server page, measured from raw server items, before UI filtering. */
  nextOffset: number;
  hasMore: boolean;
}

export const HISTORY_PAGE_SIZE = 20;
