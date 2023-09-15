export type Message = {
  timestamp: number;
  username: string;
  content: string;
};
export type Messages = {
  [key: string]: Message[];
};
