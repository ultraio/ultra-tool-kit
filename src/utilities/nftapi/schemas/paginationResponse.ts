export interface PaginationResponse<T> {
    totalCount: number;
    pagination: { limit: number; skip: number };
    data: Array<T>;
}
