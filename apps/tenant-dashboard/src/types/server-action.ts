export type ServerActionResponse<T = void> = {
  error?: string;
  data?: T;
};
