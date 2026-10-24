defmodule Sms.Switch.Smpp.Status do
  @moduledoc """
  SMPP 3.4 command_status values (spec §5.1.3). Names are the spec's, in lower case: `ESME_RINVSRCADR` is
  `:esme_rinvsrcadr`. Codes outside the table (vendor-specific 0x400–0x4FF and reserved ones) are kept as integers.
  """

  @statuses [
    esme_rok: 0x00,
    esme_rinvmsglen: 0x01,
    esme_rinvcmdlen: 0x02,
    esme_rinvcmdid: 0x03,
    esme_rinvbndsts: 0x04,
    esme_ralybnd: 0x05,
    esme_rinvprtflg: 0x06,
    esme_rinvregdlvflg: 0x07,
    esme_rsyserr: 0x08,
    esme_rinvsrcadr: 0x0A,
    esme_rinvdstadr: 0x0B,
    esme_rinvmsgid: 0x0C,
    esme_rbindfail: 0x0D,
    esme_rinvpaswd: 0x0E,
    esme_rinvsysid: 0x0F,
    esme_rcancelfail: 0x11,
    esme_rreplacefail: 0x13,
    esme_rmsgqful: 0x14,
    esme_rinvsertyp: 0x15,
    esme_rinvnumdests: 0x33,
    esme_rinvdlname: 0x34,
    esme_rinvdestflag: 0x40,
    esme_rinvsubrep: 0x42,
    esme_rinvesmclass: 0x43,
    esme_rcntsubdl: 0x44,
    esme_rsubmitfail: 0x45,
    esme_rinvsrcton: 0x48,
    esme_rinvsrcnpi: 0x49,
    esme_rinvdstton: 0x50,
    esme_rinvdstnpi: 0x51,
    esme_rinvsystyp: 0x53,
    esme_rinvrepflag: 0x54,
    esme_rinvnummsgs: 0x55,
    esme_rthrottled: 0x58,
    esme_rinvsched: 0x61,
    esme_rinvexpiry: 0x62,
    esme_rinvdftmsgid: 0x63,
    esme_rx_t_appn: 0x64,
    esme_rx_p_appn: 0x65,
    esme_rx_r_appn: 0x66,
    esme_rqueryfail: 0x67,
    esme_rinvoptparstream: 0xC0,
    esme_roptparnotallwd: 0xC1,
    esme_rinvparlen: 0xC2,
    esme_rmissingoptparam: 0xC3,
    esme_rinvoptparamval: 0xC4,
    esme_rdeliveryfailure: 0xFE,
    esme_runknownerr: 0xFF
  ]

  @by_code Map.new(@statuses, fn {name, code} -> {code, name} end)
  @by_name Map.new(@statuses)

  @type name :: atom()

  @doc "The code of a named status; an integer passes through."
  @spec code(name() | non_neg_integer()) :: non_neg_integer()
  def code(code) when is_integer(code), do: code
  def code(name), do: Map.fetch!(@by_name, name)

  @doc "The name of a code, or the code itself when the spec has no name for it."
  @spec name(non_neg_integer()) :: name() | non_neg_integer()
  def name(code), do: Map.get(@by_code, code, code)
end
