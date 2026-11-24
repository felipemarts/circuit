library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- N-bit up counter with synchronous reset and enable; wraps modulo 2**N.
entity counter is
  generic (N : positive := 4);
  port (
    clk : in  std_logic;
    rst : in  std_logic;          -- synchronous, active high
    en  : in  std_logic := '1';   -- count enable (defaults to always on)
    q   : out unsigned(N-1 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal count : unsigned(N-1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        count <= (others => '0');
      elsif en = '1' then
        count <= count + 1;
      end if;
    end if;
  end process;

  q <= count;
end architecture rtl;
