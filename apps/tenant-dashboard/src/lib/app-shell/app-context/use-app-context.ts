import { use } from "react";
import { AppContext } from "./app-context";

export const useAppContext = () => {
  return use(AppContext);
};
